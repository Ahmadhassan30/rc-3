import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Dataset, ModelConfig, ModelResult } from "./types";

const modelKeys: ModelConfig["key"][] = ["bge-small-en-v1.5", "all-MiniLM-L6-v2"];

async function directoryBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(entryPath) : (await stat(entryPath)).size;
  }
  return bytes;
}

function runModel(key: ModelConfig["key"]): Promise<ModelResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--expose-gc", "--import", "tsx", join(import.meta.dirname, "benchmark-model.ts"), key],
      { cwd: join(import.meta.dirname, "../.."), env: { ...process.env, ORT_LOG_SEVERITY_LEVEL: "3" } },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${key} benchmark exited with code ${code}`));
      const marker = output.lastIndexOf("ORBIT_RESULT_JSON=");
      if (marker < 0) return reject(new Error(`${key} did not emit a result`));
      const line = output.slice(marker + "ORBIT_RESULT_JSON=".length).trim().split("\n")[0];
      if (!line) return reject(new Error(`${key} emitted an empty result`));
      resolve(JSON.parse(line) as ModelResult);
    });
  });
}

function validateDataset(dataset: Dataset): void {
  const passageIds = new Set(dataset.passages.map(({ id }) => id));
  const candidateIds = new Set(dataset.passages.map(({ candidateId }) => candidateId));
  if (candidateIds.size < 3) throw new Error("Benchmark requires at least three candidate profiles");
  if (passageIds.size !== dataset.passages.length) throw new Error("Passage IDs must be unique");
  for (const query of dataset.queries) {
    if (query.relevantPassageIds.length === 0) {
      throw new Error(`${query.id} has no relevant passages`);
    }
    const labels = [...query.relevantPassageIds, ...query.hardNegativePassageIds];
    for (const passageId of labels) {
      if (!passageIds.has(passageId)) throw new Error(`${query.id} references unknown ${passageId}`);
    }
    if (query.relevantPassageIds.some((id) => query.hardNegativePassageIds.includes(id))) {
      throw new Error(`${query.id} labels one passage as both relevant and hard-negative`);
    }
  }
}

async function main(): Promise<void> {
  const datasetPath = join(import.meta.dirname, "dataset.json");
  const datasetBytes = await readFile(datasetPath);
  const dataset = JSON.parse(datasetBytes.toString("utf8")) as Dataset;
  validateDataset(dataset);
  const results: ModelResult[] = [];
  for (const key of modelKeys) {
    console.log(`\nBenchmarking ${key}...`);
    results.push(await runModel(key));
  }
  const packageJson = JSON.parse(
    await readFile(join(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dataset: {
      version: dataset.version,
      frozenAt: dataset.frozenAt,
      sha256: createHash("sha256").update(datasetBytes).digest("hex"),
      passages: dataset.passages.length,
      queries: dataset.queries.length,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryMiB: Number((totalmem() / 1024 / 1024).toFixed(1)),
      transformersJs: packageJson.devDependencies?.["@huggingface/transformers"] ?? "unknown",
      executionProvider: "onnxruntime-node CPU",
      dtype: "q8",
    },
    cache: {
      ignoredPath: "backend/.cache/orbit-models",
      models: {
        "onnx-community/bge-small-en-v1.5-ONNX": {
          sizeMiB: Number(
            (
              (await directoryBytes(
                join(import.meta.dirname, "../../.cache/orbit-models/onnx-community/bge-small-en-v1.5-ONNX"),
              )) /
              1024 /
              1024
            ).toFixed(3),
          ),
        },
        "Xenova/all-MiniLM-L6-v2": {
          sizeMiB: Number(
            (
              (await directoryBytes(
                join(import.meta.dirname, "../../.cache/orbit-models/Xenova/all-MiniLM-L6-v2"),
              )) /
              1024 /
              1024
            ).toFixed(3),
          ),
        },
      },
    },
    methodology: {
      similarity: "dot product of L2-normalized vectors (cosine similarity)",
      warmLatency: "30 single-query runs after 3 warmups, in one model process",
      memory: "process RSS deltas; approximate and affected by allocator behavior",
      limitation: "Small synthetic English technical corpus; retrieval relevance is not proficiency verification.",
    },
    results,
  };
  const outputPath = join(import.meta.dirname, "results.json");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

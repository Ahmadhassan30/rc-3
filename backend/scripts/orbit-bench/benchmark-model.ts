import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  Dataset,
  ModelConfig,
  ModelResult,
  QueryResult,
  RankedPassage,
} from "./types";

const configs: Record<ModelConfig["key"], ModelConfig> = {
  "bge-small-en-v1.5": {
    key: "bge-small-en-v1.5",
    modelId: "onnx-community/bge-small-en-v1.5-ONNX",
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    documentPrefix: "",
    normalize: true,
    expectedDimensions: 384,
  },
  "all-MiniLM-L6-v2": {
    key: "all-MiniLM-L6-v2",
    modelId: "Xenova/all-MiniLM-L6-v2",
    pooling: "mean",
    queryPrefix: "",
    documentPrefix: "",
    normalize: true,
    expectedDimensions: 384,
  },
};

function elapsed(start: number): number {
  return Number((performance.now() - start).toFixed(3));
}

function mib(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(3));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return Number((sorted[Math.max(0, index)] ?? 0).toFixed(3));
}

function vectorAt(data: Float32Array, index: number, dimensions: number): Float32Array {
  return data.slice(index * dimensions, (index + 1) * dimensions);
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

async function main(): Promise<void> {
  const key = process.argv[2] as ModelConfig["key"] | undefined;
  const config = key ? configs[key] : undefined;
  if (!config) throw new Error(`Unknown model key: ${key ?? "<missing>"}`);

  const dataset = JSON.parse(
    await readFile(join(import.meta.dirname, "dataset.json"), "utf8"),
  ) as Dataset;
  const rssBeforeImport = process.memoryUsage().rss;
  const importStart = performance.now();
  const { env, pipeline } = await import("@huggingface/transformers");
  const moduleImport = elapsed(importStart);

  env.cacheDir = join(import.meta.dirname, "../../.cache/orbit-models");
  env.allowLocalModels = false;
  env.allowRemoteModels = true;

  const loadStart = performance.now();
  const extractor = await pipeline("feature-extraction", config.modelId, {
    device: "cpu",
    dtype: "q8",
  });
  const modelLoad = elapsed(loadStart);
  const rssAfterLoad = process.memoryUsage().rss;

  const embed = async (texts: string[], kind: "query" | "document") => {
    const prefix = kind === "query" ? config.queryPrefix : config.documentPrefix;
    const output = await extractor(texts.map((text) => `${prefix}${text}`), {
      pooling: config.pooling,
      normalize: config.normalize,
    });
    const dimensions = output.dims.at(-1);
    if (dimensions !== config.expectedDimensions) {
      throw new Error(
        `${config.modelId} emitted ${dimensions} dimensions, expected ${config.expectedDimensions}`,
      );
    }
    return { data: output.data as Float32Array, dimensions };
  };

  const firstStart = performance.now();
  await embed([dataset.queries[0]?.text ?? "backend engineer"], "query");
  const firstInference = elapsed(firstStart);

  const corpusStart = performance.now();
  const passageEmbeddings = await embed(dataset.passages.map(({ text }) => text), "document");
  const corpusBatch = elapsed(corpusStart);
  const queryStart = performance.now();
  const queryEmbeddings = await embed(dataset.queries.map(({ text }) => text), "query");
  const queryBatch = elapsed(queryStart);

  const queryResults: QueryResult[] = dataset.queries.map((query, queryIndex) => {
    const queryVector = vectorAt(queryEmbeddings.data, queryIndex, queryEmbeddings.dimensions);
    const ranked: RankedPassage[] = dataset.passages
      .map((passage, passageIndex) => ({
        passageId: passage.id,
        score: Number(
          dot(
            queryVector,
            vectorAt(passageEmbeddings.data, passageIndex, passageEmbeddings.dimensions),
          ).toFixed(6),
        ),
        relevant: query.relevantPassageIds.includes(passage.id),
        hardNegative: query.hardNegativePassageIds.includes(passage.id),
      }))
      .sort((left, right) => right.score - left.score);
    const firstRelevantRank = ranked.findIndex(({ relevant }) => relevant) + 1;
    const recall = (at: number) =>
      ranked.slice(0, at).filter(({ relevant }) => relevant).length /
      query.relevantPassageIds.length;
    return {
      queryId: query.id,
      reciprocalRank: firstRelevantRank ? 1 / firstRelevantRank : 0,
      recallAt1: recall(1),
      recallAt3: recall(3),
      top: ranked.slice(0, 5),
    };
  });

  for (let index = 0; index < 3; index += 1) {
    await embed([dataset.queries[index % dataset.queries.length]?.text ?? "backend"], "query");
  }
  const warmLatencies: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const start = performance.now();
    await embed([dataset.queries[index % dataset.queries.length]?.text ?? "backend"], "query");
    warmLatencies.push(performance.now() - start);
  }
  if (global.gc) global.gc();
  const rssAfterInference = process.memoryUsage().rss;
  const result: ModelResult = {
    model: config,
    dimensions: queryEmbeddings.dimensions,
    metrics: {
      recallAt1: mean(queryResults.map(({ recallAt1 }) => recallAt1)),
      recallAt3: mean(queryResults.map(({ recallAt3 }) => recallAt3)),
      mrr: mean(queryResults.map(({ reciprocalRank }) => reciprocalRank)),
      hitAt1: mean(queryResults.map(({ top }) => Number(top[0]?.relevant ?? false))),
      hitAt3: mean(
        queryResults.map(({ top }) => Number(top.slice(0, 3).some(({ relevant }) => relevant))),
      ),
    },
    timingsMs: {
      moduleImport,
      modelLoad,
      firstInference,
      corpusBatch,
      queryBatch,
      warmMedian: percentile(warmLatencies, 0.5),
      warmP95: percentile(warmLatencies, 0.95),
      warmRepetitions: warmLatencies.length,
    },
    memoryMiB: {
      rssBeforeImport: mib(rssBeforeImport),
      rssAfterLoad: mib(rssAfterLoad),
      rssAfterInference: mib(rssAfterInference),
      loadDelta: mib(rssAfterLoad - rssBeforeImport),
      inferenceDelta: mib(rssAfterInference - rssAfterLoad),
    },
    queryResults,
  };
  process.stdout.write(`\nORBIT_RESULT_JSON=${JSON.stringify(result)}\n`);
  await extractor.dispose();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

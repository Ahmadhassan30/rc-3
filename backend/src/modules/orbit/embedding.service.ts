import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "onnx-community/bge-small-en-v1.5-ONNX";
export const EMBEDDING_VERSION = "bge-small-en-v1.5-q8-cls-v1";
export const EMBEDDING_DIMENSIONS = 384;
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const DEFAULT_BATCH_SIZE = 16;

type FeatureExtractor = (texts: string[], options: { pooling: "cls"; normalize: true }) => Promise<{
  data: Float32Array | ArrayLike<number>;
  dims: readonly number[];
}>;

let extractorPromise: Promise<FeatureExtractor> | undefined;

function modelCacheDirectory(): string {
  return process.env.ORBIT_MODEL_CACHE ?? join(process.cwd(), ".cache", "orbit-models");
}

async function loadExtractor(): Promise<FeatureExtractor> {
  await mkdir(modelCacheDirectory(), { recursive: true });
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDirectory();
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    device: "cpu",
    dtype: "q8",
  });
  return extractor as unknown as FeatureExtractor;
}

function getExtractor(): Promise<FeatureExtractor> {
  extractorPromise ??= loadExtractor().catch((error) => {
    extractorPromise = undefined;
    throw new Error(`BGE model could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  });
  return extractorPromise;
}

function batchSize(): number {
  const parsed = Number(process.env.ORBIT_EMBEDDING_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 64 ? parsed : DEFAULT_BATCH_SIZE;
}

function validateOutput(output: { dims: readonly number[]; data: Float32Array | ArrayLike<number> }, count: number) {
  const dimensions = Number(output.dims.at(-1));
  if (dimensions !== EMBEDDING_DIMENSIONS || output.dims.length !== 2 || output.dims[0] !== count) {
    throw new Error(`BGE emitted an unexpected shape: ${output.dims.join("x")}`);
  }
  return dimensions;
}

async function embedBatch(texts: string[], query: boolean): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor();
  const output = await extractor(
    texts.map((text) => query ? `${QUERY_PREFIX}${text}` : text),
    { pooling: "cls", normalize: true },
  );
  const dimensions = validateOutput(output, texts.length);
  return Array.from({ length: texts.length }, (_, row) =>
    Array.from(output.data).slice(row * dimensions, (row + 1) * dimensions),
  );
}

export const embeddingService = {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize()) {
      vectors.push(...await embedBatch(texts.slice(offset, offset + batchSize()), false));
    }
    return vectors;
  },
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await embedBatch([text], true);
    if (!vector) throw new Error("BGE returned no query vector");
    return vector;
  },
  metadata: {
    model: EMBEDDING_MODEL,
    version: EMBEDDING_VERSION,
    dimensions: EMBEDDING_DIMENSIONS,
    pooling: "cls" as const,
    normalized: true as const,
    device: "cpu" as const,
    dtype: "q8" as const,
  },
};

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length !== EMBEDDING_DIMENSIONS) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += (left[index] ?? 0) * (right[index] ?? 0);
  return score;
}
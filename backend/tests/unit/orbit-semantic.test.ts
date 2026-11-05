import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
  QUERY_PREFIX,
  cosineSimilarity,
  embeddingService,
} from "../../src/modules/orbit/embedding.service";

describe("Orbit semantic embeddings", () => {
  it("exposes the fixed BGE retrieval contract", () => {
    expect(EMBEDDING_MODEL).toBe("onnx-community/bge-small-en-v1.5-ONNX");
    expect(EMBEDDING_VERSION).toBe("bge-small-en-v1.5-q8-cls-v1");
    expect(EMBEDDING_DIMENSIONS).toBe(384);
    expect(QUERY_PREFIX).toBe("Represent this sentence for searching relevant passages: ");
    expect(embeddingService.metadata.pooling).toBe("cls");
    expect(embeddingService.metadata.normalized).toBe(true);
  });

  it("executes BGE and returns normalized 384-dimensional vectors", async () => {
    const [query, document] = await Promise.all([
      embeddingService.embedQuery("backend services with REST APIs"),
      embeddingService.embedDocuments(["Built versioned HTTP endpoints for external clients"]),
    ]);
    expect(query).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(document[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(cosineSimilarity(query, document[0]!)).toBeGreaterThan(0.5);
    expect(Math.abs(Math.sqrt(query.reduce((sum, value) => sum + value * value, 0)) - 1)).toBeLessThan(0.001);
  }, 30_000);
});

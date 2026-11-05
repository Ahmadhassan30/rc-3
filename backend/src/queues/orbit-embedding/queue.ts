import { Queue } from "bullmq";
import { createRedisConnection } from "../../config/redis";
import logger from "../../utils/logger";

export const ORBIT_EMBEDDING_QUEUE = "orbit-embedding";
export type EmbeddingIndexJobData = { candidateId: number; resumeKey: string; sourceHash: string };

export const orbitEmbeddingQueue = new Queue<EmbeddingIndexJobData>(ORBIT_EMBEDDING_QUEUE, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export async function requestEmbeddingIndex(data: EmbeddingIndexJobData): Promise<void> {
  await orbitEmbeddingQueue.add("index", data, {
    jobId: `${data.candidateId}:${data.resumeKey}:${data.sourceHash}`,
  });
  logger.info(`[orbit-embedding] enqueued candidate=${data.candidateId}`);
}
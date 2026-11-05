import { UnrecoverableError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { createRedisConnection } from "../../config/redis";
import { candidates, db } from "../../db";
import { indexingService, StaleEmbeddingError } from "../../modules/orbit/indexing.service";
import logger from "../../utils/logger";
import { ORBIT_EMBEDDING_QUEUE, type EmbeddingIndexJobData } from "./queue";
import { requestAssessment } from "../orbit-assessment/queue";

export function startOrbitEmbeddingWorker(): Worker<EmbeddingIndexJobData> {
  const worker = new Worker<EmbeddingIndexJobData>(
    ORBIT_EMBEDDING_QUEUE,
    async (job) => {
      try {
        const indexed = await indexingService.indexCandidate(job.data.candidateId, job.data.resumeKey, job.data.sourceHash);
        await indexingService.markCompleted(job.data.candidateId, job.data.sourceHash);
        const [candidate] = await db.select({ jobId: candidates.jobId }).from(candidates).where(eq(candidates.id, job.data.candidateId));
        if (candidate) await requestAssessment({ candidateId: job.data.candidateId, jobId: candidate.jobId, resumeKey: job.data.resumeKey });
        logger.info(`[orbit-embedding] indexed candidate=${job.data.candidateId} passages=${indexed}`);
      } catch (error) {
        if (error instanceof StaleEmbeddingError) throw new UnrecoverableError(error.message);
        await indexingService.markFailed(
          job.data.candidateId,
          job.data.sourceHash,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, error) => {
    if (job) logger.error(`[orbit-embedding] failed candidate=${job.data.candidateId}: ${error.message}`);
  });
  worker.on("error", (error) => logger.error(`[orbit-embedding] worker error: ${error.message}`));
  return worker;
}
import { Worker } from "bullmq";
import { createRedisConnection } from "../../config/redis";
import { AssessmentPendingError, assessmentService } from "../../modules/orbit/assessment.service";
import logger from "../../utils/logger";
import { ORBIT_ASSESSMENT_QUEUE, type AssessmentJobData } from "./queue";

export function startOrbitAssessmentWorker() {
  const worker = new Worker<AssessmentJobData>(ORBIT_ASSESSMENT_QUEUE, async (job) => {
    try { await assessmentService.assess(job.data.candidateId, job.data.jobId, job.data.resumeKey); }
    catch (error) {
      if (error instanceof AssessmentPendingError) throw error;
      throw error;
    }
  }, { connection: createRedisConnection(), concurrency: 1 });
  worker.on("failed", (job, error) => { if (job) logger.error(`[orbit-assessment] failed candidate=${job.data.candidateId}: ${error.message}`); });
  worker.on("error", (error) => logger.error(`[orbit-assessment] worker error: ${error.message}`));
  return worker;
}
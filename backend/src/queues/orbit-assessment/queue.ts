import { Queue } from "bullmq";
import { createRedisConnection } from "../../config/redis";

export const ORBIT_ASSESSMENT_QUEUE = "orbit-assessment";
export type AssessmentJobData = { candidateId: number; jobId: number; resumeKey: string };
export const orbitAssessmentQueue = new Queue<AssessmentJobData>(ORBIT_ASSESSMENT_QUEUE, {
  connection: createRedisConnection(),
  defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } },
});

export async function requestAssessment(data: AssessmentJobData) {
  await orbitAssessmentQueue.add("assess", data);
}
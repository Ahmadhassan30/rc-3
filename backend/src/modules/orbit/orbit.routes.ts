import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireCandidateView, requireJobView } from "../../middlewares/job-access.middleware";
import { requireManager } from "../../middlewares/role.middleware";
import { parseRoomId } from "../../shared/auth/job-access";
import logger from "../../utils/logger";
import { getErrorMessage } from "../../utils/error.utils";
import { EvidenceConflictError, orbitService } from "./orbit.service";
import { requirementService, requirementsInput, RequirementsConflictError } from "./requirements";
import { searchService } from "./search.service";
import { assessmentService } from "./assessment.service";
import { requestAssessment } from "../../queues/orbit-assessment/queue";
import { interviewQuestionService, InterviewQuestionsUnavailableError } from "./interview-questions";
import { candidates, db } from "../../db";
import { eq } from "drizzle-orm";

const router: Router = Router();
const overrideInput = z.object({
  state: z.enum(["RECRUITER_CONFIRMED", "RECRUITER_REJECTED"]),
  reason: z.string().trim().min(3).max(1000),
}).strict();
const positiveId = (value: unknown) => parseRoomId(value);
const searchQuery = z.object({
  query: z.string().trim().min(2).max(500),
  candidateId: z.coerce.number().int().positive().optional(),
  jobId: z.coerce.number().int().positive().optional(),
  section: z.enum(["experience", "projects", "skills", "education"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).strict();
function failure(res: Response, error: unknown, message: string) {
  logger.error(`[orbit] ${message}: ${getErrorMessage(error)}`);
  res.status(500).json({ error: message });
}

router.get("/search", async (req: Request, res: Response) => {
  const parsed = searchQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid semantic search query" });
  try {
    const data = await searchService.search(req.user, parsed.data.query, parsed.data);
    if (data === null) return void res.status(403).json({ error: "You do not have access to this resource" });
    res.json({ data, metadata: { model: "onnx-community/bge-small-en-v1.5-ONNX", retrievalOnly: true } });
  } catch (error) { failure(res, error, "Semantic search is unavailable"); }
});

router.get("/candidates/:candidateId/assessment", requireCandidateView(), async (req, res) => {
  const candidateId = positiveId(req.params.candidateId);
  if (!candidateId) return void res.status(400).json({ error: "Invalid candidate id" });
  const data = await assessmentService.get(candidateId);
  res.json({ data, status: data?.status ?? "waiting" });
});

router.get("/candidates/:candidateId/assessment/status", requireCandidateView(), async (req, res) => {
  const candidateId = positiveId(req.params.candidateId);
  if (!candidateId) return void res.status(400).json({ error: "Invalid candidate id" });
  const data = await assessmentService.get(candidateId);
  res.json({ data: { status: data?.status ?? "waiting", assessmentId: data?.id ?? null, updatedAt: data?.updatedAt ?? null } });
});

router.post("/candidates/:candidateId/assessment/retry", requireManager, requireCandidateView(), async (req, res) => {
  const candidateId = positiveId(req.params.candidateId);
  if (!candidateId) return void res.status(400).json({ error: "Invalid candidate id" });
  const [candidate] = await db.select({ jobId: candidates.jobId, resumeKey: candidates.resumeKey }).from(candidates).where(eq(candidates.id, candidateId));
  if (!candidate) return void res.status(404).json({ error: "Candidate not found" });
  if (!candidate.resumeKey) return void res.status(409).json({ error: "Candidate has no resume" });
  await requestAssessment({ candidateId, jobId: candidate.jobId, resumeKey: candidate.resumeKey });
  res.status(202).json({ data: { status: "pending" } });
});

router.get("/jobs/:jobId/ranking", requireJobView(), async (req, res) => {
  const jobId = positiveId(req.params.jobId);
  if (!jobId) return void res.status(400).json({ error: "Invalid job id" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const data = await assessmentService.ranking(jobId, limit, offset);
  res.json({ data, meta: { limit, offset } });
});

router.get("/candidates/:candidateId/evidence", requireCandidateView(), async (req: Request, res: Response) => {
  try {
    const data = await orbitService.candidateEvidence(positiveId(req.params.candidateId)!);
    if (!data) return void res.status(404).json({ error: "Candidate not found" });
    res.json({ data });
  } catch (error) { failure(res, error, "Failed to load evidence"); }
});

router.get("/candidates/:candidateId/status", requireCandidateView(), async (req: Request, res: Response) => {
  try {
    const data = await orbitService.candidateEvidence(positiveId(req.params.candidateId)!);
    if (!data) return void res.status(404).json({ error: "Candidate not found" });
    const { source, overrides, ...status } = data;
    res.json({ data: { ...status, evidenceReady: !!source } });
  } catch (error) { failure(res, error, "Failed to load evidence status"); }
});

router.post("/candidates/:candidateId/evidence/:factId/overrides", requireManager, requireCandidateView(), async (req: Request, res: Response) => {
  const parsed = overrideInput.safeParse(req.body);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(String(req.params.factId))) return void res.status(400).json({ error: "Invalid evidence override" });
  try {
    const data = await orbitService.override(positiveId(req.params.candidateId)!, String(req.params.factId), parsed.data.state, parsed.data.reason, req.user.id);
    if (!data) return void res.status(404).json({ error: "Candidate not found" });
    res.status(201).json({ data });
  } catch (error) {
    if (error instanceof EvidenceConflictError) return void res.status(409).json({ error: error.message });
    failure(res, error, "Failed to record evidence override");
  }
});

router.get("/jobs/:jobId/requirements", requireJobView(), async (req: Request, res: Response) => {
  try { res.json({ data: await requirementService.latest(positiveId(req.params.jobId)!) }); }
  catch (error) { failure(res, error, "Failed to load job requirements"); }
});

router.post("/jobs/:jobId/requirements", requireManager, requireJobView(), async (req: Request, res: Response) => {
  const parsed = requirementsInput.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid structured requirements", details: parsed.error.flatten() });
  try {
    const data = await requirementService.createDraft(positiveId(req.params.jobId)!, req.user.id, parsed.data);
    if (!data) return void res.status(404).json({ error: "Job not found" });
    res.status(201).json({ data });
  } catch (error) { failure(res, error, "Failed to create requirements draft"); }
});

router.post("/jobs/:jobId/requirements/:version/approve", requireManager, requireJobView(), async (req: Request, res: Response) => {
  const version = positiveId(req.params.version);
  if (!version) return void res.status(400).json({ error: "Invalid requirements version" });
  try {
    const data = await requirementService.approve(positiveId(req.params.jobId)!, version, req.user.id);
    if (!data) return void res.status(404).json({ error: "Job not found" });
    const applicants = await db.select({ id: candidates.id, jobId: candidates.jobId, resumeKey: candidates.resumeKey })
      .from(candidates).where(eq(candidates.jobId, positiveId(req.params.jobId)!));
    for (const applicant of applicants) {
      if (applicant.resumeKey) await requestAssessment({ candidateId: applicant.id, jobId: applicant.jobId, resumeKey: applicant.resumeKey });
    }
    res.json({ data });
  } catch (error) {
    if (error instanceof RequirementsConflictError) return void res.status(409).json({ error: error.message });
    failure(res, error, "Failed to approve job requirements");
  }
});

/** Recruiter-only. Reads approved requirements and verified evidence; never changes scores or stages. */
router.post("/candidates/:candidateId/interview-questions", requireManager, requireCandidateView(), async (req: Request, res: Response) => {
  const candidateId = positiveId(req.params.candidateId);
  if (!candidateId) return void res.status(400).json({ error: "Invalid candidate id" });
  try {
    const data = await interviewQuestionService.generate(candidateId);
    if (!data) return void res.status(404).json({ error: "Candidate not found" });
    res.json({ data });
  } catch (error) {
    if (error instanceof InterviewQuestionsUnavailableError) return void res.status(409).json({ error: error.message });
    failure(res, error, "Failed to generate interview questions");
  }
});

export default router;

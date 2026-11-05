import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireCandidateView, requireJobView } from "../../middlewares/job-access.middleware";
import { requireManager } from "../../middlewares/role.middleware";
import { parseRoomId } from "../../shared/auth/job-access";
import logger from "../../utils/logger";
import { getErrorMessage } from "../../utils/error.utils";
import { EvidenceConflictError, orbitService } from "./orbit.service";
import { requirementService, requirementsInput, RequirementsConflictError } from "./requirements";

const router: Router = Router();
const overrideInput = z.object({
  state: z.enum(["RECRUITER_CONFIRMED", "RECRUITER_REJECTED"]),
  reason: z.string().trim().min(3).max(1000),
}).strict();
const positiveId = (value: unknown) => parseRoomId(value);
function failure(res: Response, error: unknown, message: string) {
  logger.error(`[orbit] ${message}: ${getErrorMessage(error)}`);
  res.status(500).json({ error: message });
}

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
    res.json({ data });
  } catch (error) {
    if (error instanceof RequirementsConflictError) return void res.status(409).json({ error: error.message });
    failure(res, error, "Failed to approve job requirements");
  }
});

export default router;

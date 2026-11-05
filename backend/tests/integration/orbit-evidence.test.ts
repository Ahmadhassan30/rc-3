import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

// The development worker may use Redis DB 0. Keep this test's queue isolated from it.
vi.hoisted(() => {
  if (process.env.REDIS_URL) {
    const redis = new URL(process.env.REDIS_URL);
    redis.pathname = "/15";
    process.env.REDIS_URL = redis.toString();
  }
});

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  const { jwks } = await import("../helpers/jwks-holder");
  return { ...actual, createRemoteJWKSet: () => async () => jwks.publicKey };
});
// The optional CV analysis must not send synthetic resumes to Gemini during this test.
vi.mock("../../src/queues/cv-analysis/queue", () => ({ requestCvAnalysis: vi.fn(async () => false) }));
vi.mock("../../src/shared/services/mail.service", () => ({
  mailService: { sendEmail: vi.fn(async () => ({ id: "test" })) },
}));

import app from "../../src/app";
import { db } from "../../src/db";
import { company, departments } from "../../src/db/schema/company";
import { jobs } from "../../src/db/schema/jobs";
import { jobPipelineStages } from "../../src/db/schema/pipeline";
import { candidates } from "../../src/db/schema/candidates";
import { orbitCandidateAssessments, orbitCandidateEvidence, orbitEvidenceOverrides, orbitPassageEmbeddings } from "../../src/db/schema/orbit";
import { users } from "../../src/db/schema/users";
import { startCvExtractWorker } from "../../src/queues/cv-extract/worker";
import { startOrbitEmbeddingWorker } from "../../src/queues/orbit-embedding/worker";
import { startOrbitAssessmentWorker } from "../../src/queues/orbit-assessment/worker";
import { cvExtractQueue } from "../../src/queues/cv-extract/queue";
import { indexingService } from "../../src/modules/orbit/indexing.service";
import { cvTextService } from "../../src/modules/candidate/cv-text.service";
import { extractCvText } from "../../src/modules/candidate/cv-text";
import { verifyQuote } from "../../src/modules/orbit/evidence";
import { r2Service } from "../../src/shared/services/r2.service";
import { bearer, initTestKeys } from "../helpers/jwt";
import { buildPdf } from "../helpers/pdf";

const suffix = `orbit${Date.now()}`;
const email = `synthetic.${suffix}@example.test`;
const pdf = buildPdf([
  [
    { text: "Skills", x: 50, y: 800 },
    { text: "JS, Postgres, DRF, C++", x: 50, y: 780 },
    { text: "Experience", x: 50, y: 750 },
    { text: "Built Python and Flask APIs backed by MySQL in 2022.", x: 50, y: 730 },
    { text: "Delivered documented backend services for several teams and maintained production deployments.", x: 50, y: 710 },
    { text: "No Docker experience.", x: 50, y: 690 },
  ],
  [
    { text: "Projects", x: 50, y: 800 },
    { text: "Built Node.js services with PostgreSQL in 2023.", x: 50, y: 780 },
    { text: "Created reliable APIs and deployment documentation for a synthetic customer portal.", x: 50, y: 760 },
    { text: "Education", x: 50, y: 730 },
    { text: "Bachelor degree in software engineering, 2020.", x: 50, y: 710 },
    { text: "Completed coursework and a final year software project with comprehensive documentation.", x: 50, y: 690 },
  ],
]);

let storageDir: string;
let worker: ReturnType<typeof startCvExtractWorker>;
let embeddingWorker: ReturnType<typeof startOrbitEmbeddingWorker>;
let assessmentWorker: ReturnType<typeof startOrbitAssessmentWorker>;
let companyId: number, departmentId: number, jobId: number, candidateId: number;
let adminId: number, outsiderId: number;
let adminAuth: string, outsiderAuth: string;
let resumeKey: string;

beforeAll(async () => {
  process.env.STORAGE = "local";
  storageDir = await mkdtemp(path.join(os.tmpdir(), "orbit-evidence-"));
  process.env.STORAGE_DIR = storageDir;
  await initTestKeys();
  const admin = await bearer({ email: `admin.${suffix}@example.test`, role: "super_admin" });
  const outsider = await bearer({ email: `outsider.${suffix}@example.test`, role: "interviewer" });
  adminAuth = admin.authorization;
  outsiderAuth = outsider.authorization;
  adminId = admin.user.id;
  outsiderId = outsider.user.id;
  const [co] = await db.insert(company).values({ name: `Orbit ${suffix}`, email: `co.${suffix}@example.test` }).returning();
  companyId = co!.id;
  const [dept] = await db.insert(departments).values({ companyId, name: `Engineering ${suffix}` }).returning();
  departmentId = dept!.id;
  const [job] = await db.insert(jobs).values({
    title: "Backend Developer", slug: `backend-${suffix}`, description: "Build reliable backend systems.",
    departmentId, employmentType: "full_time", status: "published", createdBy: adminId,
  }).returning();
  jobId = job!.id;
  await db.insert(jobPipelineStages).values({ jobId, name: "Applied", position: 0 });
  worker = startCvExtractWorker();
  embeddingWorker = startOrbitEmbeddingWorker();
  assessmentWorker = startOrbitAssessmentWorker();
  await worker.waitUntilReady();
  await embeddingWorker.waitUntilReady();
  await assessmentWorker.waitUntilReady();
}, 30_000);

afterAll(async () => {
  await worker?.close();
    await embeddingWorker?.close();
    await assessmentWorker?.close();
  if (candidateId) await db.delete(candidates).where(eq(candidates.id, candidateId));
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(users).where(eq(users.id, outsiderId));
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(departments).where(eq(departments.id, departmentId));
  await db.delete(company).where(eq(company.id, companyId));
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
}, 30_000);

async function waitForEvidence() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const [candidate] = await db.select({ id: candidates.id, resumeKey: candidates.resumeKey }).from(candidates).where(eq(candidates.email, email));
    if (candidate) {
      candidateId = candidate.id;
      resumeKey = candidate.resumeKey!;
      const [snapshot] = await db.select().from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
      if (snapshot) return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const counts = await cvExtractQueue.getJobCounts();
  const failed = await cvExtractQueue.getFailed(0, 2);
  throw new Error(`The real CV worker did not persist Orbit evidence within 20 seconds: ${JSON.stringify(counts)}, failed=${failed.map((job) => job.failedReason).join(";")}`);
}

async function waitForEmbeddings() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const rows = await db.select().from(orbitPassageEmbeddings).where(eq(orbitPassageEmbeddings.candidateId, candidateId));
    const [snapshot] = await db.select({ embeddingStatus: orbitCandidateEvidence.embeddingStatus }).from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
    if (rows.length > 0 && snapshot?.embeddingStatus === "completed") return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The real BGE worker did not persist passage embeddings within 30 seconds");
}

async function waitForAssessment() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const [assessment] = await db.select().from(orbitCandidateAssessments).where(eq(orbitCandidateAssessments.candidateId, candidateId));
    if (assessment?.status === "completed") return assessment;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The real assessment worker did not persist a completed score within 30 seconds");
}

describe("Orbit real PDF integration", () => {
  it("uploads privately, applies publicly, and extracts source-linked evidence through the worker", async () => {
    const uploaded = await request(app).post("/public/upload/resume")
      .attach("file", pdf, { filename: "synthetic.pdf", contentType: "application/pdf" });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data.uploadId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(uploaded.body)).not.toContain("resumes/");

    const applied = await request(app).post(`/public/jobs/${jobId}/apply`).send({
      firstName: "Synthetic", lastName: "Applicant", email, resumeUploadId: uploaded.body.data.uploadId,
    });
    expect(applied.status).toBe(201);
    const snapshot = await waitForEvidence();
      const embeddings = await waitForEmbeddings();
    expect(await r2Service.getResume(resumeKey)).toEqual(pdf);
    expect(snapshot.pages).toHaveLength(2);
      expect(embeddings[0]!.vector).toHaveLength(384);
      expect(embeddings[0]!.sourceHash).toBe(snapshot.sourceHash);
    expect(snapshot.facts.some((f) => f.label === "JavaScript" && f.state === "MENTIONED_ONLY")).toBe(true);
    expect(snapshot.facts.some((f) => f.label === "PostgreSQL" && f.state === "SUPPORTED")).toBe(true);
    expect(snapshot.facts.some((f) => f.label === "Docker" && f.state === "NEGATED")).toBe(true);
    expect(snapshot.facts.some((f) => f.label === "Django")).toBe(false);
    for (const passage of snapshot.passages) {
      expect(snapshot.pages[passage.pageIndex]!.text.slice(passage.start, passage.end)).toBe(passage.text);
    }
    for (const fact of snapshot.facts) {
      expect(verifyQuote(snapshot, fact.passageId, fact.start, fact.end, fact.quote)).toBe(true);
    }
  }, 30_000);

  it("returns persisted private evidence to a recruiter and denies outsiders", async () => {
    expect((await request(app).get(`/api/orbit/candidates/${candidateId}/evidence`)).status).toBe(401);
    expect((await request(app).get(`/api/orbit/candidates/${candidateId}/evidence`).set("Authorization", outsiderAuth)).status).toBe(403);
    const response = await request(app).get(`/api/orbit/candidates/${candidateId}/evidence`).set("Authorization", adminAuth);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("done");
    expect(response.body.data.source.documentId).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.data.source.facts.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain(resumeKey);
    const status = await request(app).get(`/api/orbit/candidates/${candidateId}/status`).set("Authorization", adminAuth);
    expect(status.status).toBe(200);
    expect(status.body.data.evidenceReady).toBe(true);
    expect(status.body.data.source).toBeUndefined();
    const unauthorizedSearch = await request(app).get("/api/orbit/search").query({ query: "REST API", candidateId }).set("Authorization", outsiderAuth);
    expect(unauthorizedSearch.status).toBe(403);
    const search = await request(app).get("/api/orbit/search").query({ query: "Python Flask APIs", candidateId }).set("Authorization", adminAuth);
    expect(search.status).toBe(200);
    expect(search.body.data[0].candidateId).toBe(candidateId);
    expect(search.body.data[0].excerpt).toContain("APIs");
    expect(search.body.data[0].embeddingModel).toBe("onnx-community/bge-small-en-v1.5-ONNX");
    expect(search.body.data[0].warning).toContain("does not verify proficiency");
  });

  it("keeps human overrides separate, reprocessing idempotent, and rejects stale CV results", async () => {
    const [snapshot] = await db.select().from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
    const fact = snapshot!.facts.find((item) => item.label === "Docker")!;
    const override = await request(app).post(`/api/orbit/candidates/${candidateId}/evidence/${fact.id}/overrides`)
      .set("Authorization", adminAuth).send({ state: "RECRUITER_REJECTED", reason: "Reviewed source statement" });
    expect(override.status).toBe(201);
    await cvTextService.markPending(candidateId, resumeKey);
    await cvTextService.save(candidateId, resumeKey, await extractCvText(pdf));
    const [after] = await db.select().from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
    expect(after!.facts).toEqual(snapshot!.facts);
    const overrides = await db.select().from(orbitEvidenceOverrides).where(eq(orbitEvidenceOverrides.candidateId, candidateId));
    expect(overrides).toHaveLength(1);
    const replacementKey = "resumes/11111111-2222-4333-8444-555555555555.pdf";
    await db.update(candidates).set({ resumeKey: replacementKey }).where(eq(candidates.id, candidateId));
    await cvTextService.markPending(candidateId, replacementKey);
    expect(await db.select().from(orbitPassageEmbeddings).where(eq(orbitPassageEmbeddings.candidateId, candidateId))).toHaveLength(0);
    await cvTextService.save(candidateId, resumeKey, await extractCvText(pdf));
    const stale = await request(app).get(`/api/orbit/candidates/${candidateId}/evidence`).set("Authorization", adminAuth);
    expect(stale.body.data.source).toBeNull();
    await db.update(candidates).set({ resumeKey }).where(eq(candidates.id, candidateId));
    await cvTextService.markPending(candidateId, resumeKey);
    await cvTextService.save(candidateId, resumeKey, await extractCvText(pdf));
    await indexingService.indexCandidate(candidateId, resumeKey, snapshot!.sourceHash);
    await indexingService.markCompleted(candidateId, snapshot!.sourceHash);
    await waitForEmbeddings();
  }, 30_000);

  it("versions and approves job requirements only through authorized routes", async () => {
    const input = {
      requiredSkills: [{ text: "Production PostgreSQL", skill: "PostgreSQL", importance: 5 }],
      preferredSkills: [{ text: "Docker", skill: "Docker", importance: 2 }],
      minimumExperienceYears: 2,
      requiredQualifications: [],
      responsibilities: [{ text: "Build backend APIs", importance: 4 }],
    };
    expect((await request(app).post(`/api/orbit/jobs/${jobId}/requirements`).send(input)).status).toBe(401);
    expect((await request(app).post(`/api/orbit/jobs/${jobId}/requirements`).set("Authorization", outsiderAuth).send(input)).status).toBe(403);
    const draft = await request(app).post(`/api/orbit/jobs/${jobId}/requirements`).set("Authorization", adminAuth).send(input);
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe("draft");
    const version = draft.body.data.version;
    expect((await request(app).post(`/api/orbit/jobs/${jobId}/requirements/${version}/approve`).set("Authorization", outsiderAuth)).status).toBe(403);
    const approved = await request(app).post(`/api/orbit/jobs/${jobId}/requirements/${version}/approve`).set("Authorization", adminAuth);
    expect(approved.status).toBe(200);
    const assessment = await waitForAssessment();
    expect(assessment.overallScore).toBeGreaterThanOrEqual(0);
    expect(assessment.overallScore).toBeLessThanOrEqual(100);
    expect(assessment.components).toHaveProperty("skills");
    const ranking = await request(app).get(`/api/orbit/jobs/${jobId}/ranking`).set("Authorization", adminAuth);
    expect(ranking.status).toBe(200);
    expect(ranking.body.data.some((item: { candidateId: number }) => item.candidateId === candidateId)).toBe(true);
    expect(approved.body.data.status).toBe("approved");
    const retrieved = await request(app).get(`/api/orbit/jobs/${jobId}/requirements`).set("Authorization", adminAuth);
    expect(retrieved.status).toBe(200);
    expect(retrieved.body.data.requirements.requiredSkills[0].skill).toBe("PostgreSQL");
    expect(retrieved.body.data.descriptionChanged).toBe(false);
  }, 30_000);

  it("cascades private evidence and overrides when the candidate is erased", async () => {
    await db.delete(candidates).where(eq(candidates.id, candidateId));
    const snapshots = await db.select().from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
    const overrides = await db.select().from(orbitEvidenceOverrides).where(eq(orbitEvidenceOverrides.candidateId, candidateId));
    expect(snapshots).toHaveLength(0);
    expect(overrides).toHaveLength(0);
    expect(await db.select().from(orbitPassageEmbeddings).where(eq(orbitPassageEmbeddings.candidateId, candidateId))).toHaveLength(0);
    await r2Service.deleteResume(resumeKey);
    candidateId = 0;
  });
});

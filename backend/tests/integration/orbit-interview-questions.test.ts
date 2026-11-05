import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  const { jwks } = await import("../helpers/jwks-holder");
  return { ...actual, createRemoteJWKSet: () => async () => jwks.publicKey };
});

import app from "../../src/app";
import { db } from "../../src/db";
import { company, departments } from "../../src/db/schema/company";
import { jobs } from "../../src/db/schema/jobs";
import { candidates } from "../../src/db/schema/candidates";
import { orbitJobRequirements } from "../../src/db/schema/orbit";
import { users } from "../../src/db/schema/users";
import { bearer, initTestKeys } from "../helpers/jwt";

const suffix = `iq${Date.now()}`;
let companyId: number, departmentId: number, jobId: number, candidateId: number, adminId: number, outsiderId: number;
let adminAuth: string, outsiderAuth: string;
const url = () => `/api/orbit/candidates/${candidateId}/interview-questions`;

beforeAll(async () => {
  delete process.env.GROQ_API_KEY; // never call the provider from a test
  await initTestKeys();
  const admin = await bearer({ email: `admin.${suffix}@example.test`, role: "super_admin" });
  const outsider = await bearer({ email: `outsider.${suffix}@example.test`, role: "interviewer" });
  adminAuth = admin.authorization; adminId = admin.user.id;
  outsiderAuth = outsider.authorization; outsiderId = outsider.user.id;
  const [co] = await db.insert(company).values({ name: `IQ ${suffix}`, email: `co.${suffix}@example.test` }).returning();
  companyId = co!.id;
  const [dept] = await db.insert(departments).values({ companyId, name: `Eng ${suffix}` }).returning();
  departmentId = dept!.id;
  const [job] = await db.insert(jobs).values({
    title: "Backend Developer", slug: `backend-${suffix}`, description: "Build APIs.",
    departmentId, employmentType: "full_time", status: "published", createdBy: adminId,
  }).returning();
  jobId = job!.id;
  const [cand] = await db.insert(candidates).values({ firstName: "Synthetic", lastName: "Person", email: `c.${suffix}@example.test`, jobId }).returning();
  candidateId = cand!.id;
});

afterAll(async () => {
  await db.delete(candidates).where(eq(candidates.id, candidateId));
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(users).where(eq(users.id, outsiderId));
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(departments).where(eq(departments.id, departmentId));
  await db.delete(company).where(eq(company.id, companyId));
});

describe("POST /api/orbit/candidates/:id/interview-questions", () => {
  it("refuses before requirements are approved", async () => {
    const res = await request(app).post(url()).set("Authorization", adminAuth);
    expect(res.status).toBe(409);
  });

  it("is not available to a user who is not a manager on the job", async () => {
    const res = await request(app).post(url()).set("Authorization", outsiderAuth);
    expect(res.status).toBe(403);
  });

  it("returns five validated, labelled fallback questions without an LLM key and changes nothing", async () => {
    await db.insert(orbitJobRequirements).values({
      jobId, version: 1, status: "approved", descriptionHash: "x".repeat(64), createdBy: adminId,
      requirements: {
        requiredSkills: [{ id: crypto.randomUUID(), skill: "TypeScript", text: "TypeScript", importance: 5 }],
        preferredSkills: [], minimumExperienceYears: 2, requiredQualifications: [],
        responsibilities: [{ id: crypto.randomUUID(), text: "Build REST APIs", importance: 4 }],
      },
    });
    const [before] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    const res = await request(app).post(url()).set("Authorization", adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("fallback");
    expect(res.body.data.provider).toBe("deterministic-template");
    expect(res.body.data.questions).toHaveLength(5);
    for (const q of res.body.data.questions) {
      expect(["easy", "medium", "hard"]).toContain(q.difficulty);
      expect(q.expectedAnswer.length).toBeGreaterThan(10);
      // No verified evidence exists, so nothing may be quoted as evidence
      expect(q.sourceEvidence).toBeUndefined();
    }
    const [after] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(after!.currentStageId).toBe(before!.currentStageId);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });
});

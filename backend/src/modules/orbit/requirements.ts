import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, jobs, orbitJobRequirements } from "../../db";

const requirement = z.object({
  id: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(300),
  importance: z.number().int().min(1).max(5),
}).strict();
const skill = requirement.extend({ skill: z.string().trim().min(1).max(100) }).strict();

export const requirementsInput = z.object({
  requiredSkills: z.array(skill).max(50),
  preferredSkills: z.array(skill).max(50),
  minimumExperienceYears: z.number().min(0).max(80).nullable(),
  requiredQualifications: z.array(requirement).max(30),
  responsibilities: z.array(requirement).max(50),
}).strict().superRefine((input, context) => {
  const ids = [
    ...input.requiredSkills,
    ...input.preferredSkills,
    ...input.requiredQualifications,
    ...input.responsibilities,
  ].flatMap((item) => item.id ? [item.id] : []);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Requirement ids must be unique" });
  }
});
export type JobRequirements = z.infer<typeof requirementsInput>;

function withIds(input: JobRequirements): JobRequirements {
  const assign = <T extends { id?: string }>(items: T[]) => items.map((item) => ({ ...item, id: item.id ?? randomUUID() }));
  return {
    ...input,
    requiredSkills: assign(input.requiredSkills),
    preferredSkills: assign(input.preferredSkills),
    requiredQualifications: assign(input.requiredQualifications),
    responsibilities: assign(input.responsibilities),
  };
}

const descriptionHash = (description: string | null) => createHash("sha256").update(description ?? "").digest("hex");

export class RequirementsConflictError extends Error {}

export const requirementService = {
  async latest(jobId: number) {
    const [row] = await db.select().from(orbitJobRequirements)
      .where(eq(orbitJobRequirements.jobId, jobId))
      .orderBy(desc(orbitJobRequirements.version)).limit(1);
    if (!row) return null;
    const [job] = await db.select({ description: jobs.description }).from(jobs).where(eq(jobs.id, jobId));
    return { ...row, descriptionChanged: row.descriptionHash !== descriptionHash(job?.description ?? null) };
  },

  async createDraft(jobId: number, actorId: number, input: JobRequirements) {
    return db.transaction(async (tx) => {
      const [job] = await tx.select({ id: jobs.id, description: jobs.description })
        .from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (!job) return null;
      const [latest] = await tx.select({ version: orbitJobRequirements.version })
        .from(orbitJobRequirements).where(eq(orbitJobRequirements.jobId, jobId))
        .orderBy(desc(orbitJobRequirements.version)).limit(1);
      const [created] = await tx.insert(orbitJobRequirements).values({
        jobId, version: (latest?.version ?? 0) + 1,
        descriptionHash: descriptionHash(job.description),
        requirements: withIds(input), createdBy: actorId,
      }).returning();
      return created ?? null;
    });
  },

  async approve(jobId: number, version: number, actorId: number) {
    return db.transaction(async (tx) => {
      const [job] = await tx.select({ id: jobs.id, description: jobs.description })
        .from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (!job) return null;
      const [latest] = await tx.select().from(orbitJobRequirements)
        .where(eq(orbitJobRequirements.jobId, jobId))
        .orderBy(desc(orbitJobRequirements.version)).limit(1);
      if (!latest || latest.version !== version || latest.status !== "draft") throw new RequirementsConflictError("Approve the latest draft version");
      if (latest.descriptionHash !== descriptionHash(job.description)) throw new RequirementsConflictError("The job description changed; create a new draft before approval");
      const [approved] = await tx.update(orbitJobRequirements).set({ status: "approved", approvedBy: actorId, approvedAt: new Date() })
        .where(and(eq(orbitJobRequirements.id, latest.id), eq(orbitJobRequirements.status, "draft"), sql`${orbitJobRequirements.version} = ${version}`)).returning();
      if (!approved) throw new RequirementsConflictError("The draft changed during approval");
      return approved;
    });
  },
};

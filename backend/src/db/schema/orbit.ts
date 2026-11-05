import { index, integer, jsonb, pgTable, serial, text, timestamp, unique, varchar } from "drizzle-orm/pg-core";
import { candidates } from "./candidates";
import { jobs } from "./jobs";
import { users } from "./users";
import type { EvidenceFact, SourcePage, SourcePassage } from "../../modules/orbit/evidence";
import type { JobRequirements } from "../../modules/orbit/requirements";

/** One atomic snapshot for the current CV. Cascade removes all sensitive text on candidate deletion. */
export const orbitCandidateEvidence = pgTable("orbit_candidate_evidence", {
  candidateId: integer("candidate_id").primaryKey().references(() => candidates.id, { onDelete: "cascade" }),
  resumeKey: varchar("resume_key", { length: 1000 }).notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  extractorVersion: integer("extractor_version").notNull(),
  pages: jsonb("pages").$type<SourcePage[]>().notNull(),
  passages: jsonb("passages").$type<SourcePassage[]>().notNull(),
  facts: jsonb("facts").$type<EvidenceFact[]>().notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Human corrections remain separate from the immutable source-derived facts. */
export const orbitEvidenceOverrides = pgTable("orbit_evidence_overrides", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull().references(() => orbitCandidateEvidence.candidateId, { onDelete: "cascade" }),
  factId: varchar("fact_id", { length: 64 }).notNull(),
  state: varchar("state", { length: 24 }).notNull(),
  reason: text("reason").notNull(),
  decidedBy: integer("decided_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("idx_orbit_overrides_candidate_fact").on(t.candidateId, t.factId)]);

/** Each approved version is immutable; new edits create a new draft version. */
export const orbitJobRequirements = pgTable("orbit_job_requirements", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("draft"),
  source: varchar("source", { length: 16 }).notNull().default("recruiter"),
  descriptionHash: varchar("description_hash", { length: 64 }).notNull(),
  requirements: jsonb("requirements").$type<JobRequirements>().notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
}, (t) => [unique("uq_orbit_job_requirements_version").on(t.jobId, t.version), index("idx_orbit_job_requirements_job").on(t.jobId)]);

import { and, desc, eq } from "drizzle-orm";
import {
  candidates, candidateCvText, db, orbitCandidateAssessments, orbitCandidateEvidence,
  orbitJobRequirements, orbitPassageEmbeddings,
} from "../../db";
import { embeddingService, cosineSimilarity } from "./embedding.service";
import { scoreAssessment, SCORING_VERSION } from "./scoring";

export class AssessmentPendingError extends Error {}

export const assessmentService = {
  async assess(candidateId: number, jobId: number, resumeKey: string) {
    const [candidate] = await db.select({ id: candidates.id, jobId: candidates.jobId, resumeKey: candidates.resumeKey })
      .from(candidates).where(eq(candidates.id, candidateId));
    if (!candidate || candidate.jobId !== jobId || candidate.resumeKey !== resumeKey) throw new AssessmentPendingError("Candidate resume is no longer current");
    const [requirements] = await db.select().from(orbitJobRequirements)
      .where(and(eq(orbitJobRequirements.jobId, jobId), eq(orbitJobRequirements.status, "approved")))
      .orderBy(desc(orbitJobRequirements.version)).limit(1);
    if (!requirements) throw new AssessmentPendingError("Approved job requirements are not available");
    const [evidence] = await db.select().from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
    const [cv] = await db.select({ experienceYears: candidateCvText.experienceYears }).from(candidateCvText)
      .where(eq(candidateCvText.candidateId, candidateId));
    if (!evidence || evidence.resumeKey !== resumeKey || evidence.embeddingStatus !== "completed") throw new AssessmentPendingError("Resume evidence or semantic indexing is not ready");
    const vectors = await db.select().from(orbitPassageEmbeddings).where(and(
      eq(orbitPassageEmbeddings.candidateId, candidateId),
      eq(orbitPassageEmbeddings.resumeKey, resumeKey),
      eq(orbitPassageEmbeddings.embeddingVersion, embeddingService.metadata.version),
      eq(orbitPassageEmbeddings.section, "projects"),
    ));
    const projectQuery = requirements.requirements.responsibilities.map((item) => item.text).join(" ");
    const queryVector = vectors.length && projectQuery ? await embeddingService.embedQuery(projectQuery) : null;
    const projectSimilarity = queryVector ? Math.max(...vectors.map((vector) => cosineSimilarity(queryVector, vector.vector))) : null;
    const passages = new Map(evidence.passages.map((passage) => [passage.id, passage]));
    const facts = evidence.facts.map((fact) => ({ ...fact, pageIndex: passages.get(fact.passageId)?.pageIndex ?? 0 }));
    const scored = scoreAssessment({ requirements: requirements.requirements, facts, experienceYears: cv?.experienceYears === null || cv?.experienceYears === undefined ? null : Number(cv.experienceYears), projectSimilarity, projectFacts: facts.filter((fact) => fact.kind === "project") });
    const payload = {
      candidateId, jobId, resumeKey, sourceHash: evidence.sourceHash, requirementsVersion: requirements.version,
      scoringVersion: SCORING_VERSION, status: "completed", overallScore: scored.overallScore,
      components: scored.components, effectiveWeights: scored.effectiveWeights, requirements: scored.requirements,
      missingOrUncertain: scored.missingOrUncertain, processingError: null,
      embeddingModel: embeddingService.metadata.model, embeddingVersion: embeddingService.metadata.version,
      updatedAt: new Date(),
    };
    await db.delete(orbitCandidateAssessments).where(and(eq(orbitCandidateAssessments.candidateId, candidateId), eq(orbitCandidateAssessments.jobId, jobId)));
    const [saved] = await db.insert(orbitCandidateAssessments).values(payload).returning();
    return saved;
  },

  async get(candidateId: number) {
    const [row] = await db.select().from(orbitCandidateAssessments).where(eq(orbitCandidateAssessments.candidateId, candidateId)).orderBy(desc(orbitCandidateAssessments.createdAt)).limit(1);
    return row ?? null;
  },

  async ranking(jobId: number, limit: number, offset: number) {
    return db.select({ candidateId: orbitCandidateAssessments.candidateId, overallScore: orbitCandidateAssessments.overallScore, components: orbitCandidateAssessments.components, effectiveWeights: orbitCandidateAssessments.effectiveWeights, status: orbitCandidateAssessments.status, requirementsVersion: orbitCandidateAssessments.requirementsVersion, scoringVersion: orbitCandidateAssessments.scoringVersion, missingOrUncertain: orbitCandidateAssessments.missingOrUncertain })
      .from(orbitCandidateAssessments).where(eq(orbitCandidateAssessments.jobId, jobId)).orderBy(desc(orbitCandidateAssessments.overallScore)).limit(limit).offset(offset);
  },
};
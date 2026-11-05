import { and, eq } from "drizzle-orm";
import { candidates, db, orbitCandidateEvidence, orbitPassageEmbeddings } from "../../db";
import { canViewCandidate, canViewJob } from "../../shared/auth/job-access";
import type { AuthenticatedUser } from "../../shared/auth/verify-token";
import { cosineSimilarity, embeddingService } from "./embedding.service";

export type SemanticSearchFilters = { candidateId?: number; jobId?: number; section?: string; limit: number };

export const searchService = {
  async search(user: AuthenticatedUser, query: string, filters: SemanticSearchFilters) {
    if (filters.candidateId !== undefined && !(await canViewCandidate(user, filters.candidateId))) return null;
    if (filters.jobId !== undefined && !(await canViewJob(user, filters.jobId))) return null;
    const queryVector = await embeddingService.embedQuery(query);
    const conditions = [];
    if (filters.candidateId !== undefined) conditions.push(eq(orbitPassageEmbeddings.candidateId, filters.candidateId));
    if (filters.section) conditions.push(eq(orbitPassageEmbeddings.section, filters.section));
    const rows = await db.select({
      embedding: orbitPassageEmbeddings,
      jobId: candidates.jobId,
      currentResumeKey: candidates.resumeKey,
      evidence: orbitCandidateEvidence,
    }).from(orbitPassageEmbeddings)
      .innerJoin(candidates, eq(candidates.id, orbitPassageEmbeddings.candidateId))
      .innerJoin(orbitCandidateEvidence, eq(orbitCandidateEvidence.candidateId, orbitPassageEmbeddings.candidateId))
      .where(and(...conditions));
    const authorized = [];
    for (const row of rows) {
      if (row.currentResumeKey !== row.embedding.resumeKey || row.evidence.sourceHash !== row.embedding.sourceHash) continue;
      if (filters.jobId !== undefined && row.jobId !== filters.jobId) continue;
      if (filters.jobId === undefined && filters.candidateId === undefined && !(await canViewJob(user, row.jobId))) continue;
      const passage = row.evidence.passages.find((item) => item.id === row.embedding.passageId);
      if (!passage) continue;
      const facts = row.evidence.facts.filter((fact) => fact.passageId === passage.id);
      authorized.push({
        candidateId: row.embedding.candidateId, jobId: row.jobId, passageId: passage.id,
        pageIndex: passage.pageIndex, start: passage.start, end: passage.end,
        excerpt: passage.text, section: passage.section,
        similarity: cosineSimilarity(queryVector, row.embedding.vector),
        evidenceStates: [...new Set(facts.map((fact) => fact.state))],
        embeddingModel: row.embedding.embeddingModel,
        embeddingVersion: row.embedding.embeddingVersion,
        warning: "Similarity is a retrieval signal and does not verify proficiency.",
      });
    }
    return authorized.sort((left, right) => right.similarity - left.similarity).slice(0, filters.limit);
  },
};
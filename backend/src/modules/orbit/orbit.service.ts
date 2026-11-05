import { desc, eq } from "drizzle-orm";
import { db, candidates, candidateCvText, orbitCandidateEvidence, orbitEvidenceOverrides } from "../../db";
import { verifyQuote, type ExtractedEvidence } from "./evidence";

export class EvidenceConflictError extends Error {}

export const orbitService = {
  async candidateEvidence(candidateId: number) {
    const [candidate] = await db.select({ resumeKey: candidates.resumeKey }).from(candidates)
      .where(eq(candidates.id, candidateId));
    if (!candidate) return null;
    const [cv] = await db.select({
      resumeKey: candidateCvText.resumeKey,
      status: candidateCvText.status,
      errorMessage: candidateCvText.errorMessage,
      extractorVersion: candidateCvText.extractorVersion,
      updatedAt: candidateCvText.updatedAt,
    }).from(candidateCvText).where(eq(candidateCvText.candidateId, candidateId));
    const [snapshot] = await db.select().from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
    const current = snapshot && snapshot.resumeKey === candidate.resumeKey && cv?.resumeKey === candidate.resumeKey && cv.status === "done" ? snapshot : null;
    const overrides = current ? await db.select().from(orbitEvidenceOverrides)
      .where(eq(orbitEvidenceOverrides.candidateId, candidateId))
      .orderBy(desc(orbitEvidenceOverrides.createdAt), desc(orbitEvidenceOverrides.id)) : [];
    return {
      candidateId,
      status: candidate.resumeKey ? (cv?.resumeKey === candidate.resumeKey ? cv.status : "pending") : "no_resume",
      error: cv?.resumeKey === candidate.resumeKey && cv.status === "failed" ? "CV extraction failed; inspect the resume and retry the existing extraction workflow" : null,
      extractorVersion: current?.extractorVersion ?? cv?.extractorVersion ?? null,
      updatedAt: current?.updatedAt ?? cv?.updatedAt ?? null,
      source: current ? {
        documentId: current.sourceHash,
        sourceHash: current.sourceHash,
        pages: current.pages,
        passages: current.passages,
        facts: current.facts,
      } : null,
      overrides,
    };
  },

  async override(candidateId: number, factId: string, state: "RECRUITER_CONFIRMED" | "RECRUITER_REJECTED", reason: string, actorId: number) {
    return db.transaction(async (tx) => {
      const [candidate] = await tx.select({ resumeKey: candidates.resumeKey }).from(candidates)
        .where(eq(candidates.id, candidateId)).for("update");
      if (!candidate) return null;
      const [snapshot] = await tx.select().from(orbitCandidateEvidence)
        .where(eq(orbitCandidateEvidence.candidateId, candidateId));
      if (!snapshot || snapshot.resumeKey !== candidate.resumeKey) throw new EvidenceConflictError("Evidence for the current resume is unavailable");
      const fact = snapshot.facts.find((item) => item.id === factId);
      const evidence: ExtractedEvidence = { sourceHash: snapshot.sourceHash, extractorVersion: snapshot.extractorVersion, pages: snapshot.pages, passages: snapshot.passages, facts: snapshot.facts };
      if (!fact || !verifyQuote(evidence, fact.passageId, fact.start, fact.end, fact.quote)) throw new EvidenceConflictError("Source evidence cannot be verified");
      const [created] = await tx.insert(orbitEvidenceOverrides).values({ candidateId, factId, state, reason, decidedBy: actorId }).returning();
      return created ?? null;
    });
  },
};

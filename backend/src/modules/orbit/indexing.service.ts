import { and, eq } from "drizzle-orm";
import { db, orbitCandidateEvidence, orbitPassageEmbeddings } from "../../db";
import { embeddingService } from "./embedding.service";

export class StaleEmbeddingError extends Error {}

export const indexingService = {
  async indexCandidate(candidateId: number, resumeKey: string, sourceHash: string): Promise<number> {
    const [snapshot] = await db.select().from(orbitCandidateEvidence)
      .where(eq(orbitCandidateEvidence.candidateId, candidateId));
    if (!snapshot || snapshot.resumeKey !== resumeKey || snapshot.sourceHash !== sourceHash) {
      throw new StaleEmbeddingError("Source evidence was replaced before indexing");
    }
    const existing = await db.select({ passageId: orbitPassageEmbeddings.passageId, sourceHash: orbitPassageEmbeddings.sourceHash, extractorVersion: orbitPassageEmbeddings.extractorVersion })
      .from(orbitPassageEmbeddings)
      .where(and(
        eq(orbitPassageEmbeddings.candidateId, candidateId),
        eq(orbitPassageEmbeddings.embeddingVersion, embeddingService.metadata.version),
      ));
    if (existing.length === snapshot.passages.length && existing.every((row) => row.sourceHash === sourceHash && row.extractorVersion === snapshot.extractorVersion)) {
      return existing.length;
    }
    const passages = snapshot.passages;
    const vectors = await embeddingService.embedDocuments(passages.map((passage) => passage.text));
    await db.transaction(async (tx) => {
      const [current] = await tx.select({ resumeKey: orbitCandidateEvidence.resumeKey, sourceHash: orbitCandidateEvidence.sourceHash })
        .from(orbitCandidateEvidence).where(eq(orbitCandidateEvidence.candidateId, candidateId));
      if (!current || current.resumeKey !== resumeKey || current.sourceHash !== sourceHash) {
        throw new StaleEmbeddingError("Source evidence was replaced during indexing");
      }
      await tx.delete(orbitPassageEmbeddings).where(and(
        eq(orbitPassageEmbeddings.candidateId, candidateId),
        eq(orbitPassageEmbeddings.embeddingVersion, embeddingService.metadata.version),
      ));
      await tx.insert(orbitPassageEmbeddings).values(passages.map((passage, index) => ({
        candidateId, resumeKey, passageId: passage.id, sourceHash,
        extractorVersion: passage.extractorVersion, pageIndex: passage.pageIndex,
        start: passage.start, end: passage.end, section: passage.section,
        text: passage.text, embeddingModel: embeddingService.metadata.model,
        embeddingVersion: embeddingService.metadata.version,
        dimensions: embeddingService.metadata.dimensions, vector: vectors[index]!,
      })));
    });
    return passages.length;
  },

  async markFailed(candidateId: number, sourceHash: string, message: string): Promise<void> {
    await db.update(orbitCandidateEvidence).set({ embeddingStatus: "failed", embeddingError: message })
      .where(and(eq(orbitCandidateEvidence.candidateId, candidateId), eq(orbitCandidateEvidence.sourceHash, sourceHash)));
  },

  async markCompleted(candidateId: number, sourceHash: string): Promise<void> {
    await db.update(orbitCandidateEvidence).set({ embeddingStatus: "completed", embeddingError: null })
      .where(and(eq(orbitCandidateEvidence.candidateId, candidateId), eq(orbitCandidateEvidence.sourceHash, sourceHash)));
  },
};
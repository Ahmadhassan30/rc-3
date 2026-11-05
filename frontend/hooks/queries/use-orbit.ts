import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clientFetch } from "@/lib/client-fetch";

/** Mirrors backend/src/modules/orbit (routes under /api/orbit). */
export type EvidenceState =
  | "SUPPORTED" | "MENTIONED_ONLY" | "RELATED_ONLY" | "NEGATED"
  | "NOT_FOUND" | "UNCERTAIN" | "RECRUITER_CONFIRMED" | "RECRUITER_REJECTED"
  | "NOT_APPLICABLE";

export type OrbitComponents = {
  skills: number | null;
  experience: number | null;
  projects: number | null;
  qualifications: number | null;
};

export type OrbitRankingRow = {
  candidateId: number;
  overallScore: number | null;
  components: Partial<OrbitComponents>;
  effectiveWeights: Record<string, number>;
  status: string;
  requirementsVersion: number;
  scoringVersion: string;
  missingOrUncertain: string[];
};

export type OrbitRequirementAssessment = {
  id: string;
  kind: "skill" | "qualification" | "responsibility";
  label: string;
  required: boolean;
  importance: number;
  state: EvidenceState;
  score: number;
  explanation: string;
  evidence: { factId: string; passageId: string; quote: string; pageIndex: number; start: number; end: number }[];
};

export type OrbitAssessment = OrbitRankingRow & {
  id: number;
  jobId: number;
  requirements: OrbitRequirementAssessment[];
  processingError: string | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrbitEvidence = {
  candidateId: number;
  status: string;
  error: string | null;
  embeddingStatus: string | null;
  embeddingError: string | null;
  updatedAt: string | null;
  source: {
    pages: { pageIndex: number; text: string }[];
    passages: { id: string; pageIndex: number; section: string; text: string }[];
    facts: { id: string; kind: string; label: string; state: EvidenceState; passageId: string; quote: string }[];
  } | null;
};

export type RequirementItem = { id?: string; text: string; importance: number };
export type SkillItem = RequirementItem & { skill: string };
export type JobRequirements = {
  requiredSkills: SkillItem[];
  preferredSkills: SkillItem[];
  minimumExperienceYears: number | null;
  requiredQualifications: RequirementItem[];
  responsibilities: RequirementItem[];
};
export type JobRequirementsVersion = {
  id: number;
  jobId: number;
  version: number;
  status: "draft" | "approved";
  requirements: JobRequirements;
  descriptionChanged: boolean;
  createdAt: string;
  approvedAt: string | null;
};

/** Polls every 5s while `shouldPoll` says results are still expected. */
export function useOrbitRanking(jobId: number, shouldPoll: (rows: OrbitRankingRow[]) => boolean) {
  return useQuery({
    queryKey: ["orbit", "ranking", jobId],
    queryFn: () => clientFetch<{ data: OrbitRankingRow[] }>(`/orbit/jobs/${jobId}/ranking?limit=100`),
    enabled: jobId > 0,
    refetchInterval: (query) => (shouldPoll(query.state.data?.data ?? []) ? 5000 : false),
  });
}

export function useOrbitRequirements(jobId: number) {
  return useQuery({
    queryKey: ["orbit", "requirements", jobId],
    queryFn: () => clientFetch<{ data: JobRequirementsVersion | null }>(`/orbit/jobs/${jobId}/requirements`),
    enabled: jobId > 0,
  });
}

export function useOrbitAssessment(candidateId: number | null) {
  return useQuery({
    queryKey: ["orbit", "assessment", candidateId],
    queryFn: () => clientFetch<{ data: OrbitAssessment | null; status: string }>(`/orbit/candidates/${candidateId}/assessment`),
    enabled: !!candidateId,
  });
}

export function useOrbitEvidence(candidateId: number | null) {
  return useQuery({
    queryKey: ["orbit", "evidence", candidateId],
    queryFn: () => clientFetch<{ data: OrbitEvidence }>(`/orbit/candidates/${candidateId}/evidence`),
    enabled: !!candidateId,
  });
}

export function useSaveRequirements(jobId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: JobRequirements) =>
      clientFetch<{ data: JobRequirementsVersion }>(`/orbit/jobs/${jobId}/requirements`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orbit", "requirements", jobId] }),
  });
}

export function useApproveRequirements(jobId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      clientFetch<{ data: JobRequirementsVersion }>(`/orbit/jobs/${jobId}/requirements/${version}/approve`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orbit", "requirements", jobId] });
      void queryClient.invalidateQueries({ queryKey: ["orbit", "ranking", jobId] });
    },
  });
}

export function useRetryAssessment(jobId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: number) =>
      clientFetch<{ data: { status: string } }>(`/orbit/candidates/${candidateId}/assessment/retry`, { method: "POST" }),
    onSuccess: (_data, candidateId) => {
      void queryClient.invalidateQueries({ queryKey: ["orbit", "ranking", jobId] });
      void queryClient.invalidateQueries({ queryKey: ["orbit", "assessment", candidateId] });
    },
  });
}

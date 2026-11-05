import type { EvidenceFact, EvidenceState } from "./evidence";
import type { JobRequirements } from "./requirements";

export const SCORING_VERSION = "deterministic-v1";
const STATE_WEIGHT: Record<EvidenceState, number> = {
  SUPPORTED: 1, RECRUITER_CONFIRMED: 1, MENTIONED_ONLY: 0.5,
  RELATED_ONLY: 0, NEGATED: 0, NOT_FOUND: 0, UNCERTAIN: 0, RECRUITER_REJECTED: 0,
};

export type RequirementAssessment = {
  id: string;
  kind: "skill" | "qualification" | "responsibility";
  label: string;
  required: boolean;
  importance: number;
  state: EvidenceState | "NOT_APPLICABLE";
  score: number;
  explanation: string;
  evidence: Array<{ factId: string; passageId: string; quote: string; pageIndex: number; start: number; end: number }>;
};

export type AssessmentScore = {
  overallScore: number | null;
  components: { skills: number | null; experience: number | null; projects: number | null; qualifications: number | null };
  effectiveWeights: Record<string, number>;
  requirements: RequirementAssessment[];
  missingOrUncertain: string[];
};

type FactWithPassage = EvidenceFact & { pageIndex: number };

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const normalize = (value: string) => value.trim().toLowerCase();

function factFor(label: string, facts: FactWithPassage[]) {
  const matches = facts.filter((fact) => normalize(fact.label) === normalize(label));
  return matches.sort((a, b) => STATE_WEIGHT[b.state] - STATE_WEIGHT[a.state])[0];
}

function skillRequirements(requirements: JobRequirements) {
  return [
    ...requirements.requiredSkills.map((item) => ({ ...item, required: true })),
    ...requirements.preferredSkills.map((item) => ({ ...item, required: false })),
  ];
}

export function scoreAssessment(input: {
  requirements: JobRequirements;
  facts: FactWithPassage[];
  experienceYears: number | null;
  projectSimilarity: number | null;
  projectFacts: FactWithPassage[];
}): AssessmentScore {
  const requirements = skillRequirements(input.requirements);
  const assessments: RequirementAssessment[] = [];
  const missingOrUncertain: string[] = [];
  let skillTotal = 0;
  let skillEarned = 0;
  for (const requirement of requirements) {
    const fact = factFor(requirement.skill, input.facts);
    const weight = requirement.importance;
    const state = fact?.state ?? "NOT_FOUND";
    skillTotal += weight;
    skillEarned += weight * STATE_WEIGHT[state];
    if (!fact || STATE_WEIGHT[state] === 0) missingOrUncertain.push(requirement.skill);
    assessments.push({
      id: requirement.id!, kind: "skill", label: requirement.skill, required: requirement.required,
      importance: weight, state, score: Math.round(STATE_WEIGHT[state] * 100),
      explanation: fact ? `Resume evidence is ${state.toLowerCase().replaceAll("_", " ")}.` : "No verified resume evidence was found.",
      evidence: fact ? [{ factId: fact.id, passageId: fact.passageId, quote: fact.quote, pageIndex: fact.pageIndex, start: fact.start, end: fact.end }] : [],
    });
  }
  const hasExperience = input.requirements.minimumExperienceYears !== null || input.requirements.responsibilities.length > 0;
  const experience = hasExperience
    ? input.experienceYears === null ? null : clamp(input.requirements.minimumExperienceYears === null ? (input.experienceYears > 0 ? 100 : 0) : (input.experienceYears / Math.max(input.requirements.minimumExperienceYears, 1)) * 100)
    : null;
  if (experience === null && hasExperience) missingOrUncertain.push("Relevant experience");
  const projects = input.requirements.responsibilities.length > 0
    ? input.projectSimilarity === null ? null : clamp(input.projectSimilarity >= 0.72 ? 100 : input.projectSimilarity >= 0.58 ? 60 : 20)
    : null;
  if (projects === null && input.requirements.responsibilities.length > 0) missingOrUncertain.push("Project relevance");
  const qualification = input.requirements.requiredQualifications.length > 0
    ? clamp(input.requirements.requiredQualifications.reduce((total, requirement) => total + (factFor(requirement.text, input.facts)?.state === "SUPPORTED" ? requirement.importance : 0), 0) / Math.max(input.requirements.requiredQualifications.reduce((total, item) => total + item.importance, 0), 1) * 100)
    : null;
  const components = { skills: skillTotal ? clamp(skillEarned / skillTotal * 100) : null, experience, projects, qualifications: qualification };
  const applicable = Object.entries(components).filter(([, value]) => value !== null) as Array<[string, number]>;
  const baseWeights = { skills: 50, experience: 25, projects: 15, qualifications: 10 };
  const totalWeight = applicable.reduce((sum, [key]) => sum + baseWeights[key as keyof typeof baseWeights], 0);
  const effectiveWeights = Object.fromEntries(applicable.map(([key]) => [key, baseWeights[key as keyof typeof baseWeights] / totalWeight * 100]));
  const overallScore = applicable.length ? clamp(applicable.reduce((sum, [key, value]) => sum + value * (effectiveWeights[key] ?? 0) / 100, 0)) : null;
  return { overallScore, components, effectiveWeights, requirements: assessments, missingOrUncertain: [...new Set(missingOrUncertain)] };
}
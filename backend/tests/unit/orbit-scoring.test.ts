import { describe, expect, it } from "vitest";
import { scoreAssessment } from "../../src/modules/orbit/scoring";
import type { JobRequirements } from "../../src/modules/orbit/requirements";

const requirements: JobRequirements = {
  requiredSkills: [{ id: "python", text: "Python", skill: "Python", importance: 5 }],
  preferredSkills: [{ id: "django", text: "Django", skill: "Django", importance: 2 }],
  minimumExperienceYears: 2,
  requiredQualifications: [{ id: "degree", text: "Bachelor degree", importance: 1 }],
  responsibilities: [{ id: "api", text: "Build REST APIs", importance: 4 }],
};

const fact = (label: string, state: "SUPPORTED" | "MENTIONED_ONLY" | "RELATED_ONLY", pageIndex = 0) => ({
  id: `${label}-${state}`, kind: "skill" as const, label, state, passageId: "p1", start: 0, end: label.length, quote: label, dates: [], pageIndex,
});

describe("Orbit deterministic scoring", () => {
  it("uses the exact 50/25/15/10 weights when all components apply", () => {
    const result = scoreAssessment({ requirements, facts: [fact("Python", "SUPPORTED"), { ...fact("Bachelor degree", "SUPPORTED"), kind: "qualification" }], experienceYears: 2, projectSimilarity: 0.8, projectFacts: [] });
    expect(result.components.skills).toBe(71);
    expect(result.effectiveWeights).toEqual({ skills: 50, experience: 25, projects: 15, qualifications: 10 });
    expect(result.overallScore).toBe(86);
  });

  it("does not infer Django from Python or award related-only credit", () => {
    const result = scoreAssessment({ requirements, facts: [fact("Python", "SUPPORTED"), fact("Django", "RELATED_ONLY")], experienceYears: null, projectSimilarity: null, projectFacts: [] });
    const django = result.requirements.find((item) => item.label === "Django");
    expect(django?.score).toBe(0);
    expect(result.missingOrUncertain).toContain("Django");
  });

  it("redistributes weights when a component is unspecified", () => {
    const result = scoreAssessment({ requirements: { ...requirements, minimumExperienceYears: null, responsibilities: [], requiredQualifications: [] }, facts: [fact("Python", "SUPPORTED")], experienceYears: null, projectSimilarity: null, projectFacts: [] });
    expect(result.components.experience).toBeNull();
    expect(result.components.projects).toBeNull();
    expect(result.components.qualifications).toBeNull();
    expect(result.effectiveWeights).toEqual({ skills: 100 });
    expect(result.overallScore).toBe(71);
  });
});

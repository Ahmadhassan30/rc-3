import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { candidates, db, jobs, orbitJobRequirements } from "../../db";
import logger from "../../utils/logger";
import { orbitService } from "./orbit.service";
import type { JobRequirements } from "./requirements";

const groqModel = () => process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
const groqKey = () => process.env.GROQ_API_KEY?.trim();
export const FALLBACK_PROVIDER = "deterministic-template";
const LLM_TIMEOUT_MS = 30_000;
const MAX_FACTS = 25;
const MAX_QUOTE = 280;
const QUESTION_COUNT = 5;

export class InterviewQuestionsUnavailableError extends Error {}

export const interviewQuestion = z.object({
  question: z.string().trim().min(10).max(600),
  difficulty: z.enum(["easy", "medium", "hard"]),
  category: z.string().trim().min(2).max(60),
  expectedAnswer: z.string().trim().min(10).max(1200),
  relatedRequirement: z.string().trim().min(1).max(300),
  sourceEvidence: z.string().max(MAX_QUOTE + 2).optional(),
}).strict();
export type InterviewQuestion = z.infer<typeof interviewQuestion>;

/** What the model may return. Evidence is referenced by id only, and we attach the verified quote ourselves. */
const modelOutput = z.object({
  questions: z.array(z.object({
    question: z.string(),
    difficulty: z.enum(["easy", "medium", "hard"]),
    category: z.string(),
    expectedAnswer: z.string(),
    relatedRequirement: z.string(),
    evidenceId: z.string().nullable().optional(),
  })).length(QUESTION_COUNT),
});

export type InterviewQuestionsResult = {
  questions: InterviewQuestion[];
  provider: string;
  status: "generated" | "fallback";
  /** Why the fallback was used; absent when the LLM generated the questions. */
  reason?: string;
  requirementsVersion: number;
};

type VerifiedFact = { id: string; kind: string; label: string; quote: string };
type Requirement = { label: string; kind: "required skill" | "preferred skill" | "qualification" | "responsibility"; importance: number };

const bound = (text: string) => (text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text);
const norm = (value: string) => value.trim().toLowerCase();

function requirementList(req: JobRequirements): Requirement[] {
  return [
    ...req.requiredSkills.map((s) => ({ label: s.skill, kind: "required skill" as const, importance: s.importance })),
    ...req.preferredSkills.map((s) => ({ label: s.skill, kind: "preferred skill" as const, importance: s.importance })),
    ...req.requiredQualifications.map((s) => ({ label: s.text, kind: "qualification" as const, importance: s.importance })),
    ...req.responsibilities.map((s) => ({ label: s.text, kind: "responsibility" as const, importance: s.importance })),
  ].sort((a, b) => b.importance - a.importance);
}

/** Only facts the source text supports (or a recruiter confirmed), minus any a recruiter rejected. */
async function verifiedFacts(candidateId: number): Promise<VerifiedFact[]> {
  const evidence = await orbitService.candidateEvidence(candidateId);
  if (!evidence?.source) return [];
  const latestOverride = new Map<string, string>();
  for (const o of evidence.overrides) if (!latestOverride.has(o.factId)) latestOverride.set(o.factId, o.state); // newest first
  return evidence.source.facts
    .filter((f) => {
      const state = latestOverride.get(f.id) ?? f.state;
      return state === "SUPPORTED" || state === "RECRUITER_CONFIRMED";
    })
    .filter((f) => ["skill", "experience", "employment", "project", "qualification", "certification", "education"].includes(f.kind))
    .sort((a, b) => Number(b.kind === "project") - Number(a.kind === "project"))
    .slice(0, MAX_FACTS)
    .map((f) => ({ id: f.id, kind: f.kind, label: f.label, quote: bound(f.quote) }));
}

export function fallbackQuestions(requirements: Requirement[], facts: VerifiedFact[]): InterviewQuestion[] {
  const out: InterviewQuestion[] = [];
  const used = new Set<string>();
  const factFor = (label: string) => facts.find((f) => norm(f.label) === norm(label));
  const push = (q: InterviewQuestion) => { if (out.length < QUESTION_COUNT) out.push(q); };

  for (const r of requirements) {
    if (out.length >= 3) break;
    const fact = factFor(r.label);
    if (fact) {
      used.add(fact.id);
      push({
        question: `Your resume mentions ${r.label}. Walk me through a specific piece of work where you used it, the decisions you made and the result.`,
        difficulty: r.importance >= 4 ? "hard" : "medium",
        category: "Verified skill",
        expectedAnswer: `A concrete example consistent with the resume excerpt, explaining their own role, trade-offs considered with ${r.label}, and a measurable or observable outcome.`,
        relatedRequirement: r.label,
        sourceEvidence: fact.quote,
      });
    } else if (r.kind !== "responsibility") {
      push({
        question: `This role needs ${r.label}. What exposure, if any, have you had to it, and how would you get up to speed?`,
        difficulty: "medium",
        category: "Requirement gap",
        expectedAnswer: `An honest account of their level with ${r.label} (the resume does not show it), related experience that transfers, and a realistic plan to close the gap.`,
        relatedRequirement: r.label,
      });
    }
  }
  for (const project of facts.filter((f) => f.kind === "project" && !used.has(f.id))) {
    if (out.length >= 4) break;
    used.add(project.id);
    push({
      question: `Tell me about this project from your resume: "${project.label}". What was the hardest technical problem and how did you solve it?`,
      difficulty: "hard",
      category: "Project deep-dive",
      expectedAnswer: "Clear ownership of the work described, the architecture or approach chosen and why, a specific difficulty, and what they would do differently.",
      relatedRequirement: project.label,
      sourceEvidence: project.quote,
    });
  }
  const responsibility = requirements.find((r) => r.kind === "responsibility");
  push({
    question: responsibility
      ? `One responsibility of this role is: "${responsibility.label}". How would you approach it in your first month?`
      : "What kind of work would you want to be doing in this role, and what would make you effective in the first month?",
    difficulty: "easy",
    category: "Role fit",
    expectedAnswer: "A structured, realistic plan that shows they understand the responsibility and how they would learn the team's context first.",
    relatedRequirement: responsibility?.label ?? "Role responsibilities",
  });
  while (out.length < QUESTION_COUNT) {
    push({
      question: "Describe a time you had to learn an unfamiliar technology or domain quickly to deliver something. How did you go about it?",
      difficulty: "easy",
      category: "Learning ability",
      expectedAnswer: "A specific situation, the learning approach used, how they validated their understanding, and the outcome.",
      relatedRequirement: requirements[out.length % Math.max(requirements.length, 1)]?.label ?? "General",
    });
  }
  return out.map((q) => interviewQuestion.parse(q));
}

function stripFence(raw: string) {
  let text = raw.trim();
  if (text.startsWith("```")) text = (text.split("```")[1] ?? "").replace(/^json/, "").trim();
  return text;
}

/** Validates the model's answer and grounds it: requirements must be real, evidence must be one we supplied. */
export function groundModelOutput(raw: unknown, requirements: Requirement[], facts: VerifiedFact[]): InterviewQuestion[] | null {
  const parsed = modelOutput.safeParse(raw);
  if (!parsed.success) return null;
  const labels = new Map([...requirements.map((r) => r.label), ...facts.filter((f) => f.kind === "project").map((f) => f.label)].map((l) => [norm(l), l]));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: InterviewQuestion[] = [];
  for (const q of parsed.data.questions) {
    const related = labels.get(norm(q.relatedRequirement));
    if (!related) return null;
    const fact = q.evidenceId ? byId.get(q.evidenceId) : undefined;
    if (q.evidenceId && !fact) return null; // referenced evidence that does not exist
    const item = interviewQuestion.safeParse({
      question: q.question, difficulty: q.difficulty, category: q.category,
      expectedAnswer: q.expectedAnswer, relatedRequirement: related,
      ...(fact ? { sourceEvidence: fact.quote } : {}),
    });
    if (!item.success) return null;
    out.push(item.data);
  }
  return out;
}

export async function llmQuestions(jobTitle: string, requirements: Requirement[], facts: VerifiedFact[]) {
  const prompt = [
    `You write interview questions for the role "${jobTitle}". Return ONLY JSON: {"questions":[{"question","difficulty","category","expectedAnswer","relatedRequirement","evidenceId"}]} with exactly ${QUESTION_COUNT} items.`,
    "Rules:",
    "- difficulty is one of easy, medium, hard; include at least one of each.",
    "- relatedRequirement MUST be copied exactly from the REQUIREMENTS or PROJECT labels below.",
    "- evidenceId is the id of one VERIFIED EVIDENCE item the question is based on, or null.",
    "- Use ONLY the verified evidence about the candidate. Never assume experience, employers or projects not listed.",
    "- For a requirement with no evidence, ask a probing question and do not claim the candidate has it.",
    "- expectedAnswer is a short guideline (under 60 words) of what a strong answer covers.",
    "- No questions about age, family, health, religion, nationality or other protected characteristics.",
    "",
    "REQUIREMENTS:",
    ...requirements.map((r) => `- [${r.kind}, importance ${r.importance}] ${r.label}`),
    "",
    "VERIFIED EVIDENCE (resume excerpts):",
    ...(facts.length ? facts.map((f) => `- id=${f.id} [${f.kind}] ${f.label}: "${f.quote}"`) : ["(none)"]),
  ].join("\n");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: groqModel(),
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const body = await res.json() as { choices?: { message?: { content?: string } }[] };
  const response = { text: body.choices?.[0]?.message?.content ?? "" };
  return JSON.parse(stripFence(response.text ?? ""));
}

export const interviewQuestionService = {
  async generate(candidateId: number): Promise<InterviewQuestionsResult | null> {
    const [candidate] = await db.select({ jobId: candidates.jobId }).from(candidates).where(eq(candidates.id, candidateId));
    if (!candidate) return null;
    const [job] = await db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, candidate.jobId));
    const [approved] = await db.select().from(orbitJobRequirements)
      .where(and(eq(orbitJobRequirements.jobId, candidate.jobId), eq(orbitJobRequirements.status, "approved")))
      .orderBy(desc(orbitJobRequirements.version)).limit(1);
    if (!approved) throw new InterviewQuestionsUnavailableError("Approve the job requirements before generating interview questions");
    const requirements = requirementList(approved.requirements);
    const facts = await verifiedFacts(candidateId);
    const base = { requirementsVersion: approved.version };

    // Evidence excerpts (never the PDF) are sent to Groq only when the server has a key.
    if (!groqKey()) {
      return { ...base, questions: fallbackQuestions(requirements, facts), provider: FALLBACK_PROVIDER, status: "fallback", reason: "Groq is not configured" };
    }
    try {
      const grounded = groundModelOutput(await llmQuestions(job?.title ?? "this role", requirements, facts), requirements, facts);
      if (grounded) return { ...base, questions: grounded, provider: `groq:${groqModel()}`, status: "generated" };
      logger.warn(`[orbit] interview questions for candidate=${candidateId} failed validation; using fallback`);
      return { ...base, questions: fallbackQuestions(requirements, facts), provider: FALLBACK_PROVIDER, status: "fallback", reason: "LLM output failed validation" };
    } catch (error) {
      logger.warn(`[orbit] interview questions Groq call failed for candidate=${candidateId}: ${String(error)}`);
      return { ...base, questions: fallbackQuestions(requirements, facts), provider: FALLBACK_PROVIDER, status: "fallback", reason: "Groq request failed" };
    }
  },
};

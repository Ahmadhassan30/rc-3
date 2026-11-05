import { createHash } from "node:crypto";
import { headingKey, type CvSectionKey } from "../candidate/cv-text/sections";

export type EvidenceState =
  | "SUPPORTED" | "MENTIONED_ONLY" | "RELATED_ONLY" | "NEGATED"
  | "NOT_FOUND" | "UNCERTAIN" | "RECRUITER_CONFIRMED" | "RECRUITER_REJECTED";

export interface SourcePage { pageIndex: number; text: string }
export interface SourcePassage {
  id: string;
  documentId: string;
  pageIndex: number;
  start: number;
  end: number;
  text: string;
  section: CvSectionKey;
  sourceHash: string;
  extractorVersion: number;
}
export interface EvidenceFact {
  id: string;
  kind: "skill" | "employment" | "experience" | "project" | "education" | "qualification" | "certification";
  label: string;
  state: EvidenceState;
  passageId: string;
  start: number;
  end: number;
  quote: string;
  dates: string[];
}
export interface ExtractedEvidence {
  sourceHash: string;
  extractorVersion: number;
  pages: SourcePage[];
  passages: SourcePassage[];
  facts: EvidenceFact[];
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Offsets are UTF-16 String.slice indices into each canonical page. Each line is independently anchored. */
export function segmentPages(pages: string[], sourceHash: string, extractorVersion: number): SourcePassage[] {
  const passages: SourcePassage[] = [];
  for (const [pageIndex, text] of pages.entries()) {
    let section: CvSectionKey = "header";
    const lines = /[^\n]+/gu;
    for (const match of text.matchAll(lines)) {
      const line = match[0];
      const start = match.index + (line.length - line.trimStart().length);
      const end = match.index + line.trimEnd().length;
      if (start >= end) continue;
      const value = text.slice(start, end);
      const heading = headingKey(value);
      if (heading) {
        section = heading;
        continue;
      }
      // A CV without headings still has passages; classification stays conservative.
      const classified = section === "header" ? "other" : section;
      passages.push({
        id: sha256(`${sourceHash}:${pageIndex}:${start}:${end}`),
        documentId: sourceHash,
        pageIndex, start, end, text: value, section: classified,
        sourceHash, extractorVersion,
      });
    }
  }
  return passages;
}

// A full stop may end a sentence after a skill. C++/C# still cannot also match C.
const skillPattern = (body: string, flags = "giu") =>
  new RegExp(String.raw`(?<![\p{L}\p{N}.+#])(?:${body})(?![\p{L}\p{N}+#])`, flags);
const SKILLS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "C++", pattern: skillPattern(String.raw`C\+\+`, "gu") },
  { label: "C#", pattern: skillPattern("C#", "gu") },
  { label: "C", pattern: skillPattern("C", "gu") },
  { label: "Go", pattern: skillPattern("Go", "gu") },
  { label: "R", pattern: skillPattern("R", "gu") },
  { label: "JavaScript", pattern: skillPattern("JavaScript|JS") },
  { label: "PostgreSQL", pattern: skillPattern("PostgreSQL|Postgres") },
  { label: "Django REST Framework", pattern: skillPattern("Django REST Framework|DRF") },
  { label: "Django", pattern: skillPattern("Django") },
  { label: "Python", pattern: skillPattern("Python") },
  { label: "Flask", pattern: skillPattern("Flask") },
  { label: "FastAPI", pattern: skillPattern("FastAPI") },
  { label: "MySQL", pattern: skillPattern("MySQL") },
  { label: "Docker", pattern: skillPattern("Docker") },
  { label: "Node.js", pattern: skillPattern(String.raw`Node\.js|NodeJS`) },
  { label: ".NET", pattern: /(?<![\p{L}\p{N}])\.NET(?![\p{L}\p{N}+#])/giu },
];

function stateFor(passage: SourcePassage, at: number): EvidenceState {
  const clauseStart = Math.max(
    passage.text.lastIndexOf(".", at - 1),
    passage.text.lastIndexOf(";", at - 1),
    passage.text.lastIndexOf(",", at - 1),
    -1,
  );
  const prefix = passage.text.slice(clauseStart + 1, at);
  if (/(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\black(?:s|ing)?\b|\bhave not used\b|\bdid not use\b)\s+(?:(?:professional|hands-on|direct|production|prior|any)\s+){0,3}$/iu.test(prefix)) return "NEGATED";
  if (/(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\black(?:s|ing)?\b|\bhave not used\b|\bdid not use\b)[^.;,]{0,45}$/iu.test(prefix)) return "NEGATED";
  if (/(?:\bmaybe\b|\bpossibly\b|\blearning\b|\bexploring\b|\bplanned\b|\bexpected\b|\bcoursework toward\b)[^.;,]{0,45}$/iu.test(prefix)) return "UNCERTAIN";
  if (passage.section === "skills") return "MENTIONED_ONLY";
  if (passage.section === "experience" || passage.section === "projects") return "SUPPORTED";
  return "MENTIONED_ONLY";
}

function datesIn(text: string): string[] {
  return [...text.matchAll(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b|\b(?:19|20)\d{2}\b|\bpresent\b/giu)].map((m) => m[0]);
}

/** Deterministic resume claims. A quote proves only that the resume contains that claim. */
export function identifyEvidence(passages: SourcePassage[]): EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  const seen = new Set<string>();
  function add(passage: SourcePassage, kind: EvidenceFact["kind"], label: string, state: EvidenceState, start: number, end: number, dates: string[] = []) {
    const id = sha256(`${passage.id}:${kind}:${label}:${start}:${end}`);
    if (seen.has(id)) return;
    seen.add(id);
    facts.push({ id, kind, label, state, passageId: passage.id, start, end, quote: passage.text.slice(start, end), dates });
  }
  for (const passage of passages) {
    if (passage.section === "references" || passage.section === "languages") continue;
    // An unheaded CV can still contain work claims. Avoid treating names/contact lines as skills.
    if (passage.section === "other" && !/\b(?:built|used|developed|implemented|worked with|experienced in|skills?)\b/iu.test(passage.text)) continue;
    for (const { label, pattern } of SKILLS) {
      for (const match of passage.text.matchAll(pattern)) {
        add(passage, "skill", label, stateFor(passage, match.index), match.index, match.index + match[0].length);
      }
    }
    if (["experience", "projects", "education", "certifications"].includes(passage.section)) {
      const kind = passage.section === "experience" ? "employment" : passage.section === "projects" ? "project" : passage.section === "education" ? "education" : "certification";
      const dates = datesIn(passage.text);
      const uncertain = /\b(?:expected|toward|ongoing|planned|maybe|possibly|not stated|in progress)\b/iu.test(passage.text);
      add(passage, kind, passage.section, uncertain ? "UNCERTAIN" : "SUPPORTED", 0, passage.text.length, dates);
      if (kind === "employment" && dates.length) add(passage, "experience", "dated employment", uncertain ? "UNCERTAIN" : "SUPPORTED", 0, passage.text.length, dates);
      if (kind === "education" && /\b(?:degree|bachelor|master|phd|diploma|qualification)\b/iu.test(passage.text)) {
        add(passage, "qualification", "education qualification", uncertain ? "UNCERTAIN" : "SUPPORTED", 0, passage.text.length, dates);
      }
    }
  }
  const states = new Map<string, Set<EvidenceState>>();
  for (const fact of facts) if (fact.kind === "skill") {
    const set = states.get(fact.label) ?? new Set<EvidenceState>();
    set.add(fact.state);
    states.set(fact.label, set);
  }
  for (const fact of facts) if (fact.kind === "skill") {
    const set = states.get(fact.label);
    if (set?.has("NEGATED") && [...set].some((state) => state === "SUPPORTED" || state === "MENTIONED_ONLY")) fact.state = "UNCERTAIN";
  }
  return facts;
}

export function buildEvidence(pages: string[], sourceHash: string, extractorVersion: number): ExtractedEvidence {
  const sourcePages = pages.map((text, pageIndex) => ({ pageIndex, text }));
  const passages = segmentPages(pages, sourceHash, extractorVersion);
  return { sourceHash, extractorVersion, pages: sourcePages, passages, facts: identifyEvidence(passages) };
}

/** Rejects synthetic or stale quotations, including offsets based on normalized search text. */
export function verifyQuote(evidence: ExtractedEvidence, passageId: string, start: number, end: number, quote: string): boolean {
  const passage = evidence.passages.find((item) => item.id === passageId);
  const page = evidence.pages[passage?.pageIndex ?? -1];
  return !!passage && !!page && passage.sourceHash === evidence.sourceHash && passage.documentId === evidence.sourceHash &&
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= passage.text.length &&
    page.text.slice(passage.start + start, passage.start + end) === quote && passage.text.slice(start, end) === quote;
}

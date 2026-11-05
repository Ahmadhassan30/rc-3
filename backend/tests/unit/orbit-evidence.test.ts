import { describe, expect, it } from "vitest";
import { buildEvidence, verifyQuote } from "../../src/modules/orbit/evidence";
import { extractCvText, UnreadableCvError } from "../../src/modules/candidate/cv-text";
import { buildPdf } from "../helpers/pdf";

const hash = "a".repeat(64);

describe("Orbit source-linked evidence", () => {
  it("anchors repeated Unicode passages to exact canonical UTF-16 offsets", () => {
    const source = "Skills\n  JS  Postgres 🚀\n  JS  Postgres 🚀\nProjects\nBuilt JS with Postgres.";
    const evidence = buildEvidence([source], hash, 2);
    const repeated = evidence.passages.filter((p) => p.text.includes("🚀"));
    expect(repeated).toHaveLength(2);
    expect(repeated[0]!.id).not.toBe(repeated[1]!.id);
    for (const passage of evidence.passages) {
      expect(source.slice(passage.start, passage.end)).toBe(passage.text);
      expect(passage.documentId).toBe(hash);
    }
    for (const fact of evidence.facts) {
      expect(verifyQuote(evidence, fact.passageId, fact.start, fact.end, fact.quote)).toBe(true);
    }
    expect(evidence.facts.some((f) => f.label === "JavaScript" && f.state === "MENTIONED_ONLY")).toBe(true);
    expect(evidence.facts.some((f) => f.label === "JavaScript" && f.state === "SUPPORTED")).toBe(true);
    expect(evidence.facts.some((f) => f.label === "PostgreSQL")).toBe(true);
    expect(verifyQuote(evidence, repeated[0]!.id, 0, 2, "fake")).toBe(false);
  });

  it("does not promote adjacent technologies or negated and uncertain claims", () => {
    const evidence = buildEvidence([
      "Experience\nBuilt Python and Flask APIs using MySQL.\nNo Docker experience.\nMaybe learning Go.\nUsed C++, C#, C, R, Node.js, and .NET.",
    ], hash, 2);
    const skill = (label: string) => evidence.facts.filter((f) => f.kind === "skill" && f.label === label);
    expect(skill("Django")).toHaveLength(0);
    expect(skill("PostgreSQL")).toHaveLength(0);
    expect(skill("Docker")[0]?.state).toBe("NEGATED");
    expect(skill("Go")[0]?.state).toBe("UNCERTAIN");
    for (const label of ["C++", "C#", "C", "R", "Node.js", ".NET"]) expect(skill(label)).toHaveLength(1);
  });

  it("keeps contradictory claims uncertain and ignores identity text", () => {
    const evidence = buildEvidence(["Go R\nExperience\nBuilt Docker containers.\nNever used Docker."], hash, 2);
    expect(evidence.facts.filter((f) => f.label === "Docker").every((f) => f.state === "UNCERTAIN")).toBe(true);
    expect(evidence.facts.some((f) => f.label === "Go" || f.label === "R")).toBe(false);
  });

  it("extracts a genuine multipage PDF while preserving legacy merged text", async () => {
    const pdf = buildPdf([
      [
        { text: "Skills", x: 50, y: 800 },
        { text: "JS, Postgres, DRF", x: 50, y: 780 },
        { text: "Experience", x: 50, y: 750 },
        { text: "Built Python APIs with Flask in 2022.", x: 50, y: 730 },
        { text: "Delivered production backend services for several teams and documented the systems thoroughly.", x: 50, y: 710 },
      ],
      [
        { text: "Projects", x: 50, y: 800 },
        { text: "Built Node.js services with PostgreSQL in 2023.", x: 50, y: 780 },
        { text: "Education", x: 50, y: 750 },
        { text: "Bachelor degree, 2020", x: 50, y: 730 },
        { text: "Studied software engineering and completed a final year project with comprehensive documentation.", x: 50, y: 710 },
      ],
    ]);
    const cv = await extractCvText(pdf);
    expect(cv.status).toBe("done");
    expect(cv.pageCount).toBe(2);
    expect(cv.text).toContain("Built Node.js services");
    const evidence = cv.evidence!;
    expect(evidence.pages).toHaveLength(2);
    expect(evidence.facts.some((f) => f.label === "Django REST Framework")).toBe(true);
    expect(evidence.facts.some((f) => f.kind === "education")).toBe(true);
    expect(evidence.facts.some((f) => f.kind === "project")).toBe(true);
    for (const passage of evidence.passages) {
      expect(evidence.pages[passage.pageIndex]!.text.slice(passage.start, passage.end)).toBe(passage.text);
    }
  });

  it("handles empty and malformed PDFs", async () => {
    expect((await extractCvText(buildPdf([[]]))).evidence).toBeNull();
    await expect(extractCvText(Buffer.from("%PDF-1.4\nnot a pdf"))).rejects.toThrow();
    await expect(extractCvText(Buffer.from("not a pdf"))).rejects.toBeInstanceOf(UnreadableCvError);
  });
});

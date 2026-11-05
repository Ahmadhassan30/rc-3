"use client";

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  HelpCircleIcon,
  MinusSignCircleIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsManager } from "@/hooks/use-role";
import { useCandidates } from "@/hooks/queries/use-candidates";
import {
  useApproveRequirements,
  useOrbitAssessment,
  useOrbitEvidence,
  useOrbitRanking,
  useOrbitRequirements,
  useRetryAssessment,
  useSaveRequirements,
  type EvidenceState,
  type JobRequirements,
  type OrbitComponents,
  type OrbitRankingRow,
  type RequirementItem,
  type SkillItem,
} from "@/hooks/queries/use-orbit";
import type { Candidate } from "@/types";

const COMPONENTS: { key: keyof OrbitComponents; label: string }[] = [
  { key: "skills", label: "Skills" },
  { key: "experience", label: "Experience" },
  { key: "projects", label: "Projects" },
  { key: "qualifications", label: "Qualifications" },
];

type Status = "waiting" | "processing" | "completed" | "failed" | "outdated" | "no_resume";
const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  waiting: { label: "Waiting for approval", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  processing: { label: "Processing", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300" },
  completed: { label: "Completed", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  failed: { label: "Failed", cls: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" },
  outdated: { label: "Outdated", cls: "bg-slate-200 text-slate-700 dark:bg-neutral-800 dark:text-neutral-300" },
  no_resume: { label: "No resume", cls: "bg-slate-100 text-slate-500 dark:bg-neutral-800 dark:text-neutral-400" },
};

const STATE_META: Record<EvidenceState, { label: string; icon: typeof CheckmarkCircle02Icon; cls: string }> = {
  SUPPORTED: { label: "Supported", icon: CheckmarkCircle02Icon, cls: "text-emerald-600" },
  RECRUITER_CONFIRMED: { label: "Recruiter confirmed", icon: CheckmarkCircle02Icon, cls: "text-emerald-600" },
  MENTIONED_ONLY: { label: "Mentioned only", icon: MinusSignCircleIcon, cls: "text-amber-500" },
  RELATED_ONLY: { label: "Related only", icon: HelpCircleIcon, cls: "text-amber-500" },
  UNCERTAIN: { label: "Uncertain", icon: HelpCircleIcon, cls: "text-amber-500" },
  NOT_FOUND: { label: "Not found", icon: CancelCircleIcon, cls: "text-red-500" },
  NEGATED: { label: "Negated", icon: CancelCircleIcon, cls: "text-red-500" },
  RECRUITER_REJECTED: { label: "Recruiter rejected", icon: CancelCircleIcon, cls: "text-red-500" },
  NOT_APPLICABLE: { label: "Not applicable", icon: MinusSignCircleIcon, cls: "text-slate-400" },
};

const card = "rounded-xl border border-slate-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900";

function scoreColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "bg-slate-300 dark:bg-neutral-700";
  if (value >= 75) return "bg-emerald-500";
  if (value >= 50) return "bg-sky-500";
  if (value >= 25) return "bg-amber-500";
  return "bg-red-500";
}

function ScoreBar({ label, value, compact }: { label: string; value: number | null | undefined; compact?: boolean }) {
  const known = value !== null && value !== undefined;
  return (
    <div className="min-w-0">
      <div className={`flex items-baseline justify-between gap-2 ${compact ? "text-[11px]" : "text-xs"}`}>
        <span className="truncate text-slate-500 dark:text-neutral-400">{label}</span>
        <span className="font-semibold tabular-nums text-slate-900 dark:text-neutral-100">{known ? value : "n/a"}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-neutral-800">
        <div className={`h-full rounded-full transition-all ${scoreColor(value)}`} style={{ width: `${known ? value : 0}%` }} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const s = STATUS_STYLE[status];
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>;
}

function deriveStatus(candidate: Candidate, row: OrbitRankingRow | undefined, approvedVersion: number | null, retrying: boolean): Status {
  if (!candidate.hasResume) return "no_resume";
  if (retrying) return "processing";
  if (row) {
    if (row.status === "failed") return "failed";
    if (approvedVersion !== null && row.requirementsVersion < approvedVersion) return "outdated";
    if (row.status === "completed") return "completed";
    return "processing";
  }
  return approvedVersion === null ? "waiting" : "processing";
}

/* ---------------- Requirements editor ---------------- */

const toLines = (items: (RequirementItem | SkillItem)[]) =>
  items.map((i) => `${"skill" in i ? i.skill : i.text}${i.importance !== 3 ? ` | ${i.importance}` : ""}`).join("\n");

function parseLines<T extends RequirementItem>(text: string, previous: T[], skill: boolean): T[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [rawLabel, rawImp] = line.split("|").map((p) => p.trim());
    const label = (rawLabel ?? "").slice(0, skill ? 100 : 300);
    const imp = Math.min(5, Math.max(1, Math.round(Number(rawImp) || 3)));
    const prev = previous.find((p) => ("skill" in p ? (p as unknown as SkillItem).skill : p.text).toLowerCase() === label.toLowerCase());
    const base = { ...(prev?.id ? { id: prev.id } : {}), text: label, importance: imp };
    return (skill ? { ...base, skill: label } : base) as T;
  });
}

function RequirementsPanel({ jobId }: { jobId: number }) {
  const isManager = useIsManager();
  const { data, isLoading } = useOrbitRequirements(jobId);
  const save = useSaveRequirements(jobId);
  const approve = useApproveRequirements(jobId);
  const current = data?.data ?? null;
  const req = current?.requirements;

  const formFrom = () => ({
    required: toLines(req?.requiredSkills ?? []),
    preferred: toLines(req?.preferredSkills ?? []),
    qualifications: toLines(req?.requiredQualifications ?? []),
    responsibilities: toLines(req?.responsibilities ?? []),
    years: req?.minimumExperienceYears == null ? "" : String(req.minimumExperienceYears),
  });
  const [form, setForm] = useState(formFrom);
  const [editing, setEditing] = useState(false);
  const startEditing = () => { setForm(formFrom()); setEditing(true); };

  if (isLoading) return <div className={card}><Spinner /></div>;

  const onSave = () => {
    const years = form.years.trim() === "" ? null : Number(form.years);
    if (years !== null && (!Number.isFinite(years) || years < 0 || years > 80)) return void toast.error("Minimum experience must be 0-80 years.");
    const body: JobRequirements = {
      requiredSkills: parseLines<SkillItem>(form.required, req?.requiredSkills ?? [], true),
      preferredSkills: parseLines<SkillItem>(form.preferred, req?.preferredSkills ?? [], true),
      requiredQualifications: parseLines<RequirementItem>(form.qualifications, req?.requiredQualifications ?? [], false),
      responsibilities: parseLines<RequirementItem>(form.responsibilities, req?.responsibilities ?? [], false),
      minimumExperienceYears: years,
    };
    save.mutate(body, {
      onSuccess: (r) => { toast.success(`Draft v${r.data.version} saved. Approve it to run assessments.`); setEditing(false); },
      onError: (e) => toast.error(e.message),
    });
  };
  const onApprove = () => current && approve.mutate(current.version, {
    onSuccess: () => toast.success("Requirements approved. Applicants are queued for assessment."),
    onError: (e) => toast.error(e.message),
  });

  const fields: { key: keyof typeof form; label: string }[] = [
    { key: "required", label: "Required skills" },
    { key: "preferred", label: "Preferred skills" },
    { key: "qualifications", label: "Required qualifications" },
    { key: "responsibilities", label: "Responsibilities" },
  ];

  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-neutral-100">Structured job requirements</h3>
          <p className="text-xs text-slate-500 dark:text-neutral-400">
            {current ? <>Version {current.version} · <span className={current.status === "approved" ? "text-emerald-600" : "text-amber-600"}>{current.status === "approved" ? "Approved" : "Draft, awaiting approval"}</span></> : "No requirements yet. Assessments run only after requirements are approved."}
            {current?.descriptionChanged && <span className="ml-1 text-red-600">· Job description changed, save a new draft</span>}
          </p>
        </div>
        {isManager && (
          <div className="flex gap-2">
            {!editing && <Button size="sm" variant="cancel" onClick={startEditing}>{current ? "Edit" : "Create"}</Button>}
            {!editing && current?.status === "draft" && !current.descriptionChanged && (
              <Button size="sm" onClick={onApprove} disabled={approve.isPending}>{approve.isPending ? <Spinner /> : null}Approve v{current.version}</Button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-slate-500 dark:text-neutral-400">One item per line. Optional importance 1-5 after a bar, e.g. <code>TypeScript | 5</code> (default 3).</p>
          <div className="grid gap-3 md:grid-cols-2">
            {fields.map((f) => (
              <label key={f.key} className="block text-xs font-medium text-slate-700 dark:text-neutral-300">
                {f.label}
                <Textarea className="mt-1 min-h-24 font-mono text-xs" value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="block max-w-xs text-xs font-medium text-slate-700 dark:text-neutral-300">
            Minimum experience (years)
            <Input className="mt-1" type="number" min={0} max={80} value={form.years} onChange={(e) => setForm({ ...form, years: e.target.value })} />
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={onSave} disabled={save.isPending}>{save.isPending ? <Spinner /> : null}Save draft</Button>
            <Button size="sm" variant="cancel" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : req && (
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Required skills", req.requiredSkills.map((s) => s.skill)],
            ["Preferred skills", req.preferredSkills.map((s) => s.skill)],
            ["Qualifications", req.requiredQualifications.map((s) => s.text)],
            ["Responsibilities", req.responsibilities.map((s) => s.text)],
            ["Min. experience", req.minimumExperienceYears == null ? [] : [`${req.minimumExperienceYears} years`]],
          ].map(([label, items]) => (
            <div key={label as string}>
              <p className="mb-1 font-medium text-slate-500 dark:text-neutral-400">{label as string}</p>
              <div className="flex flex-wrap gap-1">
                {(items as string[]).length ? (items as string[]).map((i) => (
                  <span key={i} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-slate-700 dark:bg-neutral-800 dark:text-neutral-200">{i}</span>
                )) : <span className="text-slate-400">None</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------- Assessment panel ---------------- */

function AssessmentSheet({ candidate, status, onClose, onRetry, retrying }: {
  candidate: Candidate | null; status: Status; onClose: () => void; onRetry: (id: number) => void; retrying: boolean;
}) {
  const isManager = useIsManager();
  const id = candidate?.id ?? null;
  const { data: aData, isLoading } = useOrbitAssessment(id);
  const { data: eData } = useOrbitEvidence(id);
  const a = aData?.data ?? null;
  const ev = eData?.data;
  const matched = a?.requirements.filter((r) => r.score > 0) ?? [];
  const gaps = a?.requirements.filter((r) => r.score === 0) ?? [];
  const evidenceFailed = ev && (ev.status === "failed" || ev.embeddingStatus === "failed");

  return (
    <Sheet open={!!candidate} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto border-slate-200 p-0 data-[side=right]:w-[min(720px,100vw)] sm:max-w-none dark:border-neutral-800">
        <SheetHeader className="border-b border-slate-200 px-5 py-4 dark:border-neutral-800">
          <SheetTitle className="flex items-center gap-2 text-base font-semibold">
            <HugeiconsIcon icon={AiBrain01Icon} className="size-5 text-[var(--theme-color)]" />
            {candidate?.firstName} {candidate?.lastName}
            <StatusPill status={evidenceFailed && status !== "completed" ? "failed" : status} />
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-5 px-5 py-5">
          {isLoading ? <Spinner /> : !a ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-neutral-700">
              No assessment yet. {status === "waiting" ? "Approve the job requirements to start assessments." : "The background worker is processing this resume."}
              {(ev?.error || ev?.embeddingError) && <p className="mt-2 text-red-600">{ev.error ?? ev.embeddingError}</p>}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <div className="flex size-28 shrink-0 flex-col items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-neutral-800">
                  <span className="text-4xl font-bold tabular-nums">{a.overallScore ?? "n/a"}</span>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400">Relevance</span>
                </div>
                <div className="grid flex-1 grid-cols-2 gap-x-5 gap-y-3">
                  {COMPONENTS.map((c) => (
                    <div key={c.key}>
                      <ScoreBar label={c.label} value={a.components[c.key]} />
                      {a.effectiveWeights[c.key] !== undefined && <p className="mt-0.5 text-[10px] text-slate-400">weight {Math.round(a.effectiveWeights[c.key]!)}%</p>}
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-slate-400">
                Requirements v{a.requirementsVersion} · {a.scoringVersion}{a.embeddingModel ? ` · ${a.embeddingModel}` : ""} · updated {new Date(a.updatedAt).toLocaleString()}
              </p>
              {a.processingError && <p className="text-sm text-red-600">{a.processingError}</p>}

              {a.missingOrUncertain.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300"><HugeiconsIcon icon={Alert02Icon} className="size-4" />Missing or uncertain</p>
                  <div className="flex flex-wrap gap-1">{a.missingOrUncertain.map((m) => <span key={m} className="rounded bg-white px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{m}</span>)}</div>
                </div>
              )}

              {[["Matched requirements", matched], ["Gaps", gaps]].map(([title, list]) => (list as typeof matched).length > 0 && (
                <div key={title as string}>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title as string}</h4>
                  <ul className="space-y-2">
                    {(list as typeof matched).map((r) => {
                      const meta = STATE_META[r.state] ?? STATE_META.UNCERTAIN;
                      return (
                        <li key={r.id} className="rounded-lg border border-slate-200 p-3 dark:border-neutral-800">
                          <div className="flex items-center gap-2">
                            <HugeiconsIcon icon={meta.icon} className={`size-4 shrink-0 ${meta.cls}`} />
                            <span className="text-sm font-medium text-slate-900 dark:text-neutral-100">{r.label}</span>
                            {r.required && <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600 dark:bg-neutral-800 dark:text-neutral-300">required</span>}
                            <span className="ml-auto text-[11px] text-slate-500">{meta.label} · importance {r.importance}</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500 dark:text-neutral-400">{r.explanation}</p>
                          {r.evidence.map((e) => (
                            <blockquote key={e.factId} className="mt-2 border-l-2 border-[var(--theme-color)] bg-slate-50 py-1.5 pl-3 pr-2 text-xs text-slate-700 dark:bg-neutral-800/60 dark:text-neutral-200">
                              “{e.quote}”<span className="ml-2 whitespace-nowrap text-[10px] text-slate-400">Resume p. {e.pageIndex + 1}</span>
                            </blockquote>
                          ))}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </>
          )}

          {ev?.source && (
            <details className="rounded-lg border border-slate-200 p-3 text-xs dark:border-neutral-800">
              <summary className="cursor-pointer font-semibold text-slate-700 dark:text-neutral-200">All extracted resume evidence ({ev.source.facts.length})</summary>
              <ul className="mt-2 space-y-1.5">
                {ev.source.facts.map((f) => {
                  const meta = STATE_META[f.state] ?? STATE_META.UNCERTAIN;
                  const page = ev.source!.passages.find((p) => p.id === f.passageId)?.pageIndex;
                  return (
                    <li key={f.id} className="flex gap-2">
                      <HugeiconsIcon icon={meta.icon} className={`mt-0.5 size-3.5 shrink-0 ${meta.cls}`} />
                      <span><span className="font-medium">{f.label}</span> <span className="text-slate-400">({f.kind}{page !== undefined ? `, p. ${page + 1}` : ""})</span> <span className="text-slate-500">“{f.quote}”</span></span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {isManager && candidate?.hasResume && status !== "waiting" && (
            <Button size="sm" variant="cancel" disabled={retrying} onClick={() => candidate && onRetry(candidate.id)}>
              {retrying ? <Spinner /> : <HugeiconsIcon icon={RefreshIcon} />}Re-run assessment
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ---------------- Ranking tab ---------------- */

export function AiRankingTab({ jobId }: { jobId: number }) {
  const isManager = useIsManager();
  const { data: candData, isLoading: candLoading } = useCandidates(jobId, undefined, { enabled: jobId > 0 });
  const { data: reqData } = useOrbitRequirements(jobId);
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const retry = useRetryAssessment(jobId);

  const req = reqData?.data ?? null;
  const approvedVersion = req?.status === "approved" ? req.version : null;
  const hasApproved = approvedVersion !== null || (req?.version ?? 0) > 1;

  const candidates = useMemo(() => candData?.data ?? [], [candData]);
  const { data: rankData, isLoading: rankLoading } = useOrbitRanking(jobId, (ranked) => {
    if (retrying.size > 0) return true;
    if (!hasApproved) return false;
    const done = new Set(ranked.filter((r) => approvedVersion === null || r.requirementsVersion >= approvedVersion).map((r) => r.candidateId));
    return candidates.some((c) => c.hasResume && !done.has(c.id));
  });
  const byCandidate = useMemo(() => new Map((rankData?.data ?? []).map((r) => [r.candidateId, r])), [rankData]);

  const rows = useMemo(() => {
    const list = candidates.map((c) => {
      const row = byCandidate.get(c.id);
      return { c, row, status: deriveStatus(c, row, hasApproved ? approvedVersion ?? row?.requirementsVersion ?? null : null, retrying.has(c.id)) };
    });
    return list.sort((a, b) => (b.row?.overallScore ?? -1) - (a.row?.overallScore ?? -1));
  }, [candidates, byCandidate, approvedVersion, hasApproved, retrying]);

  const onRetry = (id: number) => retry.mutate(id, {
    onSuccess: () => {
      setRetrying((s) => new Set(s).add(id));
      toast.success("Assessment queued.");
      // Polling picks up the fresh result; clear the flag after a short window
      setTimeout(() => setRetrying((s) => { const n = new Set(s); n.delete(id); return n; }), 20000);
    },
    onError: (e) => toast.error(e.message),
  });

  const selected = rows.find((r) => r.c.id === selectedId) ?? null;
  const top = rows.filter((r) => r.row?.overallScore != null).slice(0, 3);

  return (
    <div className="space-y-5">
      <RequirementsPanel jobId={jobId} />

      {top.length > 1 && (
        <section className={card}>
          <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-neutral-100">Top candidates compared</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {top.map(({ c, row }, i) => (
              <button key={c.id} onClick={() => setSelectedId(c.id)} className="rounded-lg border border-slate-200 p-3 text-left transition-colors hover:border-[var(--theme-color)] dark:border-neutral-800">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="truncate text-sm font-medium">#{i + 1} {c.firstName} {c.lastName}</span>
                  <span className="text-2xl font-bold tabular-nums">{row!.overallScore}</span>
                </div>
                <div className="space-y-1.5">{COMPONENTS.map((k) => <ScoreBar key={k.key} compact label={k.label} value={row!.components[k.key]} />)}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className={`${card} p-0`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-neutral-800">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-neutral-100">
            <HugeiconsIcon icon={AiBrain01Icon} className="size-4 text-[var(--theme-color)]" />AI candidate ranking
          </h3>
          <span className="text-xs text-slate-500">{byCandidate.size} of {candidates.length} assessed</span>
        </div>
        {candLoading || rankLoading ? <div className="p-6"><Spinner /></div> : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">No applicants for this job yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-neutral-800">
            {rows.map(({ c, row, status }, i) => (
              <li key={c.id} className="grid grid-cols-1 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,2fr)_auto]">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-6 text-right text-xs tabular-nums text-slate-400">{row?.overallScore != null ? i + 1 : "–"}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-neutral-100">{c.firstName} {c.lastName}</p>
                    <div className="mt-0.5 flex items-center gap-2"><StatusPill status={status} />{c.stageName && <span className="truncate text-[11px] text-slate-400">{c.stageName}</span>}</div>
                  </div>
                </div>
                <div className="text-3xl font-bold tabular-nums text-slate-900 md:w-16 md:text-center dark:text-neutral-100">{row?.overallScore ?? <span className="text-base font-normal text-slate-400">n/a</span>}</div>
                <div className="min-w-0 space-y-2">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 lg:grid-cols-4">{COMPONENTS.map((k) => <ScoreBar key={k.key} compact label={k.label} value={row?.components[k.key]} />)}</div>
                  {row && row.missingOrUncertain.length > 0 && (
                    <p className="truncate text-[11px] text-amber-700 dark:text-amber-400" title={row.missingOrUncertain.join(", ")}>Missing: {row.missingOrUncertain.join(", ")}</p>
                  )}
                </div>
                <div className="flex gap-2 md:justify-end">
                  {isManager && c.hasResume && (status === "failed" || status === "outdated" || status === "processing") && (
                    <Button size="icon-sm" variant="cancel" title="Retry assessment" disabled={retry.isPending} onClick={() => onRetry(c.id)}><HugeiconsIcon icon={RefreshIcon} /></Button>
                  )}
                  <Button size="sm" variant="cancel" onClick={() => setSelectedId(c.id)}>View evidence</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AssessmentSheet
        candidate={selected?.c ?? null}
        status={selected?.status ?? "waiting"}
        onClose={() => setSelectedId(null)}
        onRetry={onRetry}
        retrying={selected ? retrying.has(selected.c.id) || retry.isPending : false}
      />
    </div>
  );
}

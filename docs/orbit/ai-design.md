# Orbit AI design — Task 2A decision record

Status: research and implementation blueprint only. No production AI behavior is
implemented by Task 2A.

## 1. Verified repository map

| Concern | Existing source and observed behavior | Task 2B seam |
|---|---|---|
| Private upload | `backend/src/modules/upload/upload.controller.ts` creates a one-time PDF upload; `backend/src/shared/services/r2.service.ts` delegates to `local-storage.ts` for `STORAGE=local`. | Reuse without exposing a public file route. |
| CV extraction | `backend/src/modules/candidate/cv-text/extract-pdf.ts` limits PDFs to 30 pages and joins page text; `index.ts:extractCvText` cleans text and builds a profile. | Preserve page text and source offsets before merging. |
| Persistence | `backend/src/modules/candidate/cv-text/cv-text.service.ts` stores status/text/search text/page and character counts/sections/profile in `candidate_cv_text` from `backend/src/db/schema/candidates.ts`. A candidate/resume-key condition prevents stale writes. | Trigger assessment only after the matching extraction reaches `completed`. |
| Queue lifecycle | `backend/src/modules/candidate/cv-text/cv-extract.queue.ts` uses BullMQ with three exponential-backoff attempts. `cv-extract.worker.ts` runs two jobs concurrently, enforces a 30-second extraction timeout, and records final failure. `backend/src/worker.ts` starts all workers. | Add one BullMQ assessment queue and worker; do not add another queue system. |
| Application hook | `backend/src/modules/candidate/candidate.controller.ts` requests CV extraction after application/resume replacement, and separately requests legacy CV analysis when enabled. | Enqueue assessment from completed extraction, not from upload, so parsing is not duplicated. |
| Job/candidate data | `backend/src/db/schema/jobs.ts` stores title, description, skills and existing recruiter scoring weights. `candidates.ts` stores candidate CV text and legacy CV analysis. Assessment/interview schemas already exist in their modules. | Add separate versioned AI requirements/assessment records; never overwrite recruiter workflow scores. |
| Existing LLM | `backend/src/modules/candidate/cv-analysis.service.ts` lazily creates `GoogleGenAI`, sends the PDF, uses `gemini-3-flash-preview`, applies a 30-second timeout, strips code fences, and casts parsed JSON without runtime schema validation. Its queue is feature-gated and retries three times. | Reuse the configured Gemini provider, but send bounded extracted passages and validate structured JSON with Zod. Do not reuse unsafe aliases or make it score/status-authoritative. |
| Authorization | `backend/src/shared/auth/job-access.ts` and candidate/job middleware restrict data by super-admin or hiring-team membership, with an assigned-interviewer exception for interview access. | Apply the same job/candidate view guards; requirement edits and reassessment are manager-only. |
| Runtime/tests | Backend compiles as CommonJS on Node 22 and uses Vitest. `@huggingface/transformers` 4.3.2 exposes a Node CommonJS entry and loaded successfully in this repository. | Load one embedding model in the worker process and cache it; avoid loading it in every API process. |

The current extraction record contains merged text and semantic sections, but no
stable character offsets or page anchors. Consequently, existing stored sections
cannot support an auditable “page N, characters X–Y” quotation without a small
extraction/persistence extension.

## 2. Embedding research and measured benchmark

The benchmark is in `backend/scripts/orbit-bench/`. It uses 17 synthetic passages,
9 queries and labels fixed before inference. It includes aliases, paraphrases,
related frameworks/databases, explicit negation, skills-list-only mentions,
unrelated projects and ambiguous education. Full rankings and environment metadata
are in `results.json`.

| Model | Documented setup used | R@1 | R@3 | MRR | Hit@3 | Cached load | Warm p50 / p95 | RSS load delta | Cache |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `onnx-community/bge-small-en-v1.5-ONNX` | q8 CPU, query prefix, CLS, L2 normalize | 0.481 | 0.852 | 0.800 | 0.889 | 413 ms | 9.203 / 10.395 ms | 191.2 MiB | 32.752 MiB |
| `Xenova/all-MiniLM-L6-v2` | q8 CPU, mean pooling, L2 normalize | 0.407 | 0.852 | 0.787 | 0.889 | 428 ms | 4.234 / 5.008 ms | 202.0 MiB | 22.588 MiB |

These are cached-run measurements on this machine, not published leaderboard values.
The initial uncached downloads took 27.3 seconds for BGE and 14.5 seconds for MiniLM;
network conditions dominate those values. RSS is allocator-sensitive and is not
model-file size. The corpus is deliberately small, synthetic, English-only and not
an accuracy claim for hiring. Retrieval labels identify useful passages, never
candidate proficiency.

Observed errors are architecturally important: BGE ranked “No Docker experience”
first for a broad Docker query and related FastAPI work above actual Django work;
MiniLM also ranked skills-list mentions above supported experience in some cases.
No cosine threshold can convert these results into verified evidence.

Model-card facts:

- [BGE small v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) is MIT licensed,
  384-dimensional, has a 512-token sequence length, and documents the retrieval
  query prefix. The [Transformers.js ONNX card](https://huggingface.co/onnx-community/bge-small-en-v1.5-ONNX)
  specifies CLS pooling and normalization.
- [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
  is Apache-2.0 licensed, 384-dimensional, truncates beyond 256 word pieces, and
  documents attention-aware mean pooling. Its [Transformers.js card](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
  documents mean pooling and normalization.
- [e5-small-v2](https://huggingface.co/intfloat/e5-small-v2) is a plausible
  English-only, 384-dimensional alternative requiring `query:`/`passage:` prefixes.
  It was not benchmarked because neither primary model failed and a third download
  would not improve the minimum architecture decision.
- Transformers.js documents the [feature-extraction pipeline](https://huggingface.co/docs/transformers.js/en/api/pipelines)
  and configurable [local cache](https://huggingface.co/docs/transformers.js/en/api/env).

**Decision:** use BGE small v1.5 as the single production embedding space. It won
Recall@1 and MRR on the fixed corpus while retaining the same top-3 recall as
MiniLM. Its roughly 10 ms warm query latency remains negligible relative to PDF and
LLM work. Re-evaluate with a larger recruiter-reviewed corpus; MiniLM is the fallback
where worker CPU throughput becomes the dominant constraint. Never mix vectors
from these models; persist the model ID/version with every assessment.

## 3. Evidence-verification contract

Embeddings retrieve candidate passages only. A proposed fact must carry a source
anchor and pass deterministic verification before scoring.

| State | Meaning |
|---|---|
| `SUPPORTED` | The exact stored source contains the quoted resume claim and it satisfies the normalized requirement. This proves that the resume makes the claim, not that the claim is objectively true. |
| `MENTIONED_ONLY` | The term appears (for example in a skills list) without experience, project or assessment evidence. |
| `RELATED_ONLY` | Evidence concerns a related but non-equivalent concept (FastAPI is not Django; MySQL is not PostgreSQL). |
| `NOT_FOUND` | No valid evidence exists, or the only exact occurrence is explicitly negated. |
| `UNCERTAIN` | Source is ambiguous, conflicting, incomplete, or cannot be anchored exactly. |
| `RECRUITER_CONFIRMED` | Authorized human explicitly accepted the evidence/claim. |
| `RECRUITER_REJECTED` | Authorized human explicitly rejected it; this overrides machine proposals until a later audited correction. |

Task 2B must retain raw page text and create passages with `page`, `start`, `end`,
`text`, and a hash of the source text. Normalize into a separate search field;
never calculate raw offsets on lowercased/whitespace-collapsed text. LLM-proposed
quotes must match the raw source exactly after only deterministic line-ending
canonicalization. Reject fabricated/truncated matches rather than fuzzy-matching
them into `SUPPORTED`.

Use a small reviewed alias map only for true aliases (`js` ↔ `javascript`,
`postgres` ↔ `postgresql`). Frameworks, databases, and adjacent practices are
relations, not aliases. Apply token-aware negation within the containing sentence,
preserve conflicting positive and negative claims as `UNCERTAIN`, and deduplicate
the same source span so it cannot score twice.

Treat resume/job text as untrusted instructions. The prompt must delimit it as
data, prohibit following embedded instructions, limit passage count/length, and
request facts plus verbatim excerpts. Use Gemini structured output with a JSON
schema and then Zod runtime validation; Google's documentation still recommends
application-side semantic validation ([Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)).
On validation failure, timeout, missing quote, or source-hash mismatch, retry through
BullMQ and ultimately record a reviewable processing error—never infer success.

## 4. LLM and Laya decisions

Reuse the existing Gemini provider for job requirement proposals, resume fact and
project interpretation, and interview-question drafts. Introducing another provider
adds configuration, privacy and failure modes without a demonstrated benefit.
Record provider/model/prompt-schema version, timestamps and input source hashes.
Gemini proposes structured facts; deterministic code anchors evidence and computes
scores. It cannot change stages, reject/shortlist/select, or write authoritative
recruiter decisions. Task 2A made no paid API call.

Laya outcome: **DEFER**. Its [source repository](https://github.com/NandhaKishorM/laya)
offers typed choice/score/yes-no classification and Apache-2.0 checkpoints, but the
documented checkpoints are 322M–421M parameters, its principal integration is
Python, its published examples are not evidence-grounded recruitment validation,
and the referenced `laya-ts` package was not available from npm during this review.
It may merit a later labeled classification experiment, but cannot justify a second
model runtime during a five-hour integration.

## 5. Deterministic scoring contract

For four applicable components:

`overall = 0.50 × skills + 0.25 × experience + 0.15 × projects + 0.10 × qualifications`

Each component is 0–100. Within a component, compute a weighted average of reviewed
job requirements. Required/preferred is metadata, not an automatic rejection;
default importance may be 2/1 but must be visible and recruiter-editable. Evidence
credit is deterministic and versioned: confirmed/supported = 1.0, mentioned-only =
0.35, related-only = 0.20, uncertain/not-found/rejected = 0. These are transparent
product heuristics, not empirically calibrated hiring accuracy. A recruiter
confirmation/rejection changes the state and enqueues a versioned reassessment.

If a job genuinely omits a component, exclude it and renormalize the remaining base
weights, recording effective weights; never penalize a candidate for an unspecified
requirement. Required data that is merely missing remains `NOT_FOUND`, not zero years
invented by the model. Calculate experience only from explicit start/end dates,
merge overlapping intervals, use the assessment date for “present,” and mark
ambiguous dates uncertain. Project relevance uses BGE retrieval followed by anchored
fact verification. Education uses explicit awarded qualification/field evidence;
coursework without completion is uncertain.

Do not extract or score names, photographs, age/dates of birth, gender, nationality,
ethnicity, religion, disability, marital/family status, addresses or other protected
or identity proxies. Do not use school prestige as a quality signal.

```ts
type EvidenceState =
  | "SUPPORTED" | "MENTIONED_ONLY" | "RELATED_ONLY" | "NOT_FOUND" | "UNCERTAIN"
  | "RECRUITER_CONFIRMED" | "RECRUITER_REJECTED";

interface EvidenceRef {
  page: number;
  start: number;
  end: number;
  quote: string;
  sourceHash: string;
}

interface RequirementAssessment {
  requirementId: string;
  component: "skills" | "experience" | "projects" | "qualifications";
  state: EvidenceState;
  evidence: EvidenceRef[];
  explanation: string;
  humanReviewRequired: boolean;
}

interface AssessmentResult {
  assessmentId: string;
  candidateId: number;
  jobId: number;
  overallScore: number | null;
  components: Record<"skills" | "experience" | "projects" | "qualifications", number | null>;
  effectiveWeights: Record<string, number>;
  requirements: RequirementAssessment[];
  missingOrUncertain: string[];
  metadata: {
    schemaVersion: number;
    scoringVersion: string;
    embeddingModel: string;
    llmProvider: string;
    llmModel: string;
    promptVersion: string;
    sourceHash: string;
  };
  processingErrors: Array<{ stage: string; code: string; message: string }>;
  humanReviewFlags: string[];
}
```

## 6. Task 2B minimum-change blueprint

### Data flow

1. Reuse the private upload and `extractCvText` path.
2. Extend extraction to persist raw per-page text and stable passage anchors while
   retaining current merged/search/profile fields unchanged.
3. After the matching CV extraction completes, enqueue one idempotent assessment
   job keyed by candidate, job, resume key, requirements version and source hash.
4. Load BGE once per worker process from an ignored persistent cache; retrieve a
   small top-k set for each reviewed job requirement.
5. Ask Gemini for structured fact proposals over only those bounded passages.
6. Validate Zod shape, exact quotes, offsets, negation, safe aliases and conflicts.
7. Compute versioned deterministic components/overall and persist an AI assessment
   separate from recruiter-owned workflow scores.
8. Serve explanations/evidence to authorized users; human overrides create audit
   records and enqueue reassessment. Hiring stage remains entirely recruiter-owned.

### Concrete modules

Reuse `candidate.controller.ts`, `cv-text/index.ts`, `extract-pdf.ts`,
`cv-text.service.ts`, existing BullMQ connection patterns, `cv-analysis.service.ts`
configuration, `ai-settings.service.ts`, and job/candidate access middleware.

Add under `backend/src/modules/orbit/`:

- `orbit.types.ts` and Zod contracts;
- `passage.service.ts` for raw anchors, segmentation and exact verification;
- `requirement.service.ts` for versioned reviewed job requirements;
- `embedding.service.ts` for the singleton BGE pipeline/cache and cosine retrieval;
- `fact-extraction.service.ts` for prompt boundaries and Gemini structured output;
- `evidence.service.ts` for aliases, negation, conflicts and evidence states;
- `scoring.service.ts` for pure deterministic functions;
- `assessment.service.ts`, `assessment.queue.ts`, `assessment.worker.ts`, and
  `assessment.controller.ts` for orchestration, persistence and endpoints.

Extend `backend/src/db/schema/candidates.ts` with source-page/passages storage or a
dedicated source table, and add a new `backend/src/db/schema/orbit.ts` containing
versioned `orbit_job_requirements`, `orbit_candidate_assessments`, and audited
evidence overrides. Use the repository's normal Drizzle migration workflow. JSONB
is acceptable for immutable result snapshots; index `(job_id, candidate_id,
created_at)` and unique idempotency keys. No vector database is needed: embed the
small passage set in memory per assessment and persist model metadata, not a new
infrastructure tier.

### API and controls

- `GET/PUT /api/jobs/:jobId/orbit/requirements` — view; manager-only edit/review.
- `POST /api/jobs/:jobId/orbit/requirements/extract` — manager-only asynchronous proposal.
- `GET /api/candidates/:candidateId/orbit/assessment` — candidate-view guard.
- `POST /api/candidates/:candidateId/orbit/assessment/retry` — manager-only.
- `POST /api/candidates/:candidateId/orbit/evidence/:requirementId/override` —
  manager-only, reason required, audited.
- `POST /api/jobs/:jobId/orbit/interview-questions` — manager/interviewer policy,
  returns drafts only and never schedules or submits an evaluation.

Gate all work behind an `ORBIT_AI_ENABLED` setting plus existing Gemini enablement.
Retries must distinguish transient provider/runtime failure from permanent invalid
source/validation errors. Use bounded concurrency because each worker holds roughly
200 MiB additional RSS in this benchmark. Never log resume passages, prompts,
provider keys or full model responses.

### Test contract and implementation order

1. Schema/migrations and source-anchor extraction tests, including normalization
   offset stability, replacement-resume stale-write protection and private storage.
2. Pure evidence tests for exact quote, JS alias, Django/FastAPI and PostgreSQL/MySQL
   separation, negation, conflict, deduplication and prompt-injection text.
3. Pure scoring tests for fixed weights, omitted components, duration overlap,
   uncertainty and recruiter overrides.
4. Embedding singleton/cache tests plus the fixed synthetic retrieval benchmark.
5. Gemini contract tests with mocked valid/invalid/timeout responses; no live key.
6. Queue idempotency/retry/failure integration tests and assessment audit metadata.
7. API authorization tests for super admin, hiring manager, team member, interviewer
   and unrelated user; verify no endpoint can mutate hiring stage.
8. UI work only after the backend result contract is stable.

## 7. Known risks and unresolved questions

- The synthetic benchmark is too small for a hiring-quality claim; build a
  consented, de-identified, recruiter-labeled evaluation set before tuning top-k or
  similarity behavior.
- Existing merged CV text lacks stable page anchors; Task 2B must add them before
  evidence can be called auditable.
- Provider data-retention/region terms and the exact Gemini production model must be
  approved before real resumes leave the local system.
- CPU/RSS capacity and BullMQ concurrency must be load-tested on the deployment
  host; benchmark RSS is approximate.
- Job requirements need recruiter review before candidate scoring; raw LLM proposals
  are not an authoritative job specification.

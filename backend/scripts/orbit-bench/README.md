# Orbit embedding benchmark

This isolated benchmark compares real local ONNX inference for the two Task 2A
embedding candidates. It does not import or change production services, access a
database, read resumes, or call an LLM.

The labels in `dataset.json` were written before inference. They measure whether a
passage is useful for the exact query, not whether a candidate has objectively
proven a skill. Explicit negation and related technologies are deliberately hard
negatives.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./backend bench:orbit
```

The first run downloads model files into `backend/.cache/orbit-models/`; `.cache/`
is ignored by Git. Each model executes in a fresh Node process. The runner writes
the complete environment, rankings, retrieval metrics, latency, and RSS memory
measurements to `results.json`.

The benchmark uses CPU inference with q8 ONNX weights. BGE uses its documented
retrieval query prefix, CLS pooling, and normalization. MiniLM uses mean pooling
and normalization. Warm latency is 30 single-query runs after three warmups.

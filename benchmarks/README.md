# Model benchmarks

Which local model should Igor default to? Measured through Ollama (0.40.7, Vulkan) on an AMD Ryzen AI 9 HX 370 / Radeon 890M iGPU laptop, 124 GB shared memory.

`bench.py` sends a synthetic Element-style room (random chat lines with two planted facts) plus three tool-call prompts, and records speed, recall and tool selection. Everything is synthetic; no real room content is used.

```sh
BENCH_LINES=110 BENCH_OUT=results/run.jsonl python3 -I bench.py gemma4:26b-a4b-it-qat SparkLLM/Spark-X2.6-4B:q4_k_m
```

Settings: `num_ctx` 16384, `think: false`, temperature 0, `num_predict` 120. Q1 is a cold prompt (measures prefill); Q2 reuses the prefix (warm). Recall passes when the answer contains the planted fact; tools pass when the expected tool is called.

## Results (`results/2026-10-28-clean-5k.*`)

~5.5k-token prompt, load average 6-8 on 24 cores (one busy core plus a browser), so reasonably clean but not lab-grade.

| Model | Prefill tok/s | Decode tok/s | Cold prompt | Recall | Tools |
|---|---|---|---|---|---|
| `gemma4:e4b-it-qat` | 746 | 22.4 | 11.9 s | 2/2 | 3/3 |
| `SparkLLM/Spark-X2.6-4B:q8_0` | 672 | 14.7 | 11.9 s | 2/2 | 3/3 |
| `SparkLLM/Spark-X2.6-4B:q4_k_m` | 654 | 21.9 | 11.4 s | 2/2 | 3/3 |
| `gemma4:26b-a4b-it-qat` | 639 | 21.2 | 16.3 s | 2/2 | 3/3 |
| `gemma4:12b` | 253 | 8.4 | 28.0 s | 2/2 | 3/3 |

## Earlier gemma4 sweep (`results/2026-10-28-gemma4-sweep.jsonl`)

Speed only. The prompt was ~21k tokens and Ollama truncated it to ~8.2k, dropping the middle, so `qa1_ok` is false for every model and is **not** a quality signal. Speeds are valid for an ~8k-token prompt.

| Model | Prefill tok/s | Decode tok/s | Cold 8k prompt |
|---|---|---|---|
| `gemma4:e4b-it-qat` | 753 | 21.1 | 14.8 s |
| `gemma4:26b-a4b-it-qat` | 633 | 23.3 | 18.8 s |
| `gemma4:26b-a4b-it-q4_K_M` | 561 | 21.1 | 24.6 s |
| `gemma4:26b-a4b-it-mtp-q4_K_M` | 529 | 20.3 | 26.2 s |
| `gemma4:12b-it-qat` | 285 | 8.3 | 35.6 s |
| `gemma4:12b` | 256 | 9.1 | 38.7 s |
| `gemma4:31b-it-qat` | - | - | crashed (Vulkan `ErrorDeviceLost`) |

Takeaways: MoE `26b-a4b` is ~2.5x faster than dense `12b`; the `mtp` variant gives no gain; dense `31b` is not usable on this iGPU; Spark `q8_0` decodes a third slower than `q4_k_m` with no quality gain on these tests.

## Limits of the current benchmark

Both candidates score 100% on recall and tools, so it cannot separate them on quality: only speed differs. The prompt is also shorter than a real room (~10k tokens).

## Next: synthetic benchmarks that can separate the models

Generate rooms from a structured event list so ground truth is known, seed everything, and score deterministically (substring/set match) rather than with an LLM judge.

1. **Needle recall grid:** 5-10 facts at depths 5-95% across 2k/6k/12k-token contexts, with near-duplicate distractors (a decision that is later revised; the latest must win). Output a depth x length recall heatmap.
2. **Aggregation and multi-hop:** "who mentioned X most", "which tickets did A raise that B answered", counts by day. Ground truth is computed from the generator.
3. **Summary faithfulness:** render a scripted sequence of events as chat, ask for a summary, score a checklist of required events and count claims not in the event list (hallucination rate).
4. **Absent-fact abstention:** questions whose answer is not in the room; the right output is "not in the messages". Measures confident guessing.
5. **Citation accuracy:** Igor cites messages as `#id`; check that each cited id actually contains the claimed content.
6. **Tool use depth:** mock tool backend with canned results; score call sequences (search then fetch then answer), argument exactness (query/URL/count), not calling a tool when the context already has the answer, wrong-tool distractors, parallel calls, numeric arguments.
7. **Performance curves:** prefill, decode and time-to-first-token at 2k/4k/8k/16k/32k context, thinking on vs off (Spark has none/low/high), warm vs cold.

Statistical hygiene: at least 30 items per category with confidence intervals, interleave models (ABAB) to cancel thermal and load drift, repeat speed runs and report mean and spread, and record the load average at start and end of every run. Keep prompts below Ollama's ~8k truncation limit unless `num_ctx` is verified to apply (check the `truncated` field in results).

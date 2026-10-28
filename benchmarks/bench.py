# Usage: BENCH_LINES=110 BENCH_OUT=results/run.jsonl python3 -I bench.py <ollama model> [...]
# Keep prompt + output under num_ctx: Ollama truncates longer prompts (the middle is dropped) and recall scores become meaningless.
import json, random, subprocess, sys, time, urllib.request

BASE = "http://localhost:11434"
MODELS = sys.argv[1:]
import os
OUT = os.environ.get("BENCH_OUT", "bench.jsonl")
LINES = int(os.environ.get("BENCH_LINES", "430"))
NUM_CTX = 16384


def post(path, body, timeout=900):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def installed():
    return {m["name"] for m in json.loads(urllib.request.urlopen(BASE + "/api/tags").read())["models"]}


def unload_all():
    for m in json.loads(urllib.request.urlopen(BASE + "/api/ps").read())["models"]:
        post("/api/generate", {"model": m["name"], "keep_alive": 0})
    time.sleep(2)


rnd = random.Random(7)
names = ["Alex", "Jesse", "Marga", "Mario", "Hector", "Carmen", "Juanjo", "Samuel"]
topics = [
    "the LLVM backend", "the CI queue", "the new linter", "flaky tests on arm64", "the wasm toolchain",
    "code review latency", "the nightly build", "the docs site", "the proof assistant", "register allocation",
    "the fuzzing setup", "the package mirror", "the release notes", "the benchmark suite", "the migration plan",
]
verbs = ["looks stable now", "keeps failing for me", "needs another look", "was merged yesterday", "is blocked on review",
         "regressed a bit last week", "should be fine after the rebase", "still has an open question", "is on my list for Friday"]


def build_context(nonce, lines=LINES):
    out = []
    for i in range(lines):
        h, m = 9 + i // 60, i % 60
        who = rnd.choice(names)
        t = rnd.choice(topics)
        out.append(f"[2026-10-2{1 + i // 150} {h:02d}:{m:02d}] {who}: I checked {t} and it {rnd.choice(verbs)}; "
                   f"see ticket {rnd.randint(1000, 9999)} for the details and the earlier thread.")
    out[int(lines * 0.12)] = "[2026-10-21 10:00] Alex: heads up, the release freeze is on 14 November, not the 7th."
    out[int(lines * 0.75)] = "[2026-10-22 14:00] Jesse: I benchmarked the new allocator and it was 23% faster on tail latency."
    return f"(session {nonce})\n" + "\n".join(out)


SYSTEM = ("You are Igor, an assistant in a sidebar next to the Element chat client. Answer questions about the "
          "conversation in the current room. Be concise.\n\nMost recent messages, oldest first:\n\n")

TOOLS = [
    {"type": "function", "function": {"name": "web_search", "description": "Search the web.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "fetch_url", "description": "Fetch a web page's text.",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {"name": "get_older_messages", "description": "Load older messages from the current room.",
        "parameters": {"type": "object", "properties": {"count": {"type": "number"}}, "required": ["count"]}}},
]
TOOL_CASES = [
    ("What is the latest stable Rust release? Look it up.", "web_search"),
    ("Summarise the page https://example.com/changelog for me.", "fetch_url"),
    ("What was discussed in this room last month? You only see recent messages; get 80 older ones first.", "get_older_messages"),
]


def chat(model, messages, tools=None, predict=120):
    body = {"model": model, "stream": False, "think": False, "messages": messages,
            "options": {"num_ctx": NUM_CTX, "num_predict": predict, "temperature": 0}}
    if tools:
        body["tools"] = tools
    t0 = time.time()
    r = post("/api/chat", body)
    r["_wall"] = time.time() - t0
    return r


def rate(n, ns):
    return round(n / (ns / 1e9), 1) if ns else None


def emit(rec):
    with open(OUT, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)


for model in MODELS:
    while model not in installed():
        time.sleep(15)
    unload_all()
    try:
        ctx = SYSTEM + build_context(f"{model}-{time.time()}")
        msgs = [{"role": "system", "content": ctx}]
        r1 = chat(model, msgs + [{"role": "user", "content": "When is the release freeze? One sentence."}])
        r2 = chat(model, msgs + [{"role": "user", "content": "How much faster was Jesse's allocator? One sentence."}])
        tool_res = []
        for q, want in TOOL_CASES:
            r = chat(model, [{"role": "system", "content": "You are Igor, an assistant with tools. Use a tool when needed."},
                             {"role": "user", "content": q}], tools=TOOLS, predict=100)
            calls = r["message"].get("tool_calls") or []
            names_called = [c["function"]["name"] for c in calls]
            tool_res.append({"want": want, "got": names_called, "ok": want in names_called, "wall": round(r["_wall"], 1)})
        emit({
            "model": model,
            "truncated": (r1.get("prompt_eval_count") or 0) >= 8190,
            "load_s": round(r1.get("load_duration", 0) / 1e9, 1),
            "prompt_tokens": r1.get("prompt_eval_count"),
            "prefill_tok_s": rate(r1.get("prompt_eval_count"), r1.get("prompt_eval_duration")),
            "cold_wall_s": round(r1["_wall"], 1),
            "decode_tok_s": rate(r1.get("eval_count"), r1.get("eval_duration")),
            "warm_wall_s": round(r2["_wall"], 1),
            "warm_decode_tok_s": rate(r2.get("eval_count"), r2.get("eval_duration")),
            "qa1_ok": "14" in r1["message"]["content"] and "November" in r1["message"]["content"],
            "qa2_ok": "23" in r2["message"]["content"],
            "qa_answers": [r1["message"]["content"][:120], r2["message"]["content"][:120]],
            "tools": tool_res,
        })
    except Exception as e:
        emit({"model": model, "error": str(e)})
    unload_all()

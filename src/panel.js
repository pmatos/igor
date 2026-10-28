import { extractRoom } from "./extract.js";

const DEFAULTS = {
  baseUrl: "http://localhost:11434",
  numCtx: 16384,
  maxMsgs: 200,
  model: "",
  useCtx: true,
  useTools: true,
};

const $ = (id) => document.getElementById(id);
const el = { model: $("model"), log: $("log"), input: $("input"), send: $("send"), info: $("ctx-info"), grant: $("grant") };

let cfg = { ...DEFAULTS };
let history = [];
let abort = null;

async function loadCfg() {
  cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("base-url").value = cfg.baseUrl;
  $("num-ctx").value = cfg.numCtx;
  $("max-msgs").value = cfg.maxMsgs;
  $("use-ctx").checked = cfg.useCtx;
  $("use-tools").checked = cfg.useTools;
}

function save(patch) {
  Object.assign(cfg, patch);
  chrome.storage.local.set(patch);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderMarkdown(text) {
  return escapeHtml(text)
    .replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>")
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (m) => m.replace(/<br>/g, "\n"));
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "assistant") div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}

async function loadModels() {
  el.model.replaceChildren();
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models } = await res.json();
    for (const m of models) el.model.add(new Option(m.name, m.name));
    if (!models.length) throw new Error("no models pulled");
    el.model.value = models.some((m) => m.name === cfg.model) ? cfg.model : models[0].name;
    save({ model: el.model.value });
  } catch (e) {
    addMsg("error", `Cannot list models from ${cfg.baseUrl}: ${e.message}. Is Ollama running with OLLAMA_ORIGINS=chrome-extension://* ?`);
  }
}

async function activeTab() {
  // ?tab=<id> lets the panel run as a normal tab (testing) and target another tab
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) return chrome.tabs.get(forced);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function getRoom(limit) {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url ?? "")) return { error: "no-tab" };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: extractRoom,
      args: [limit],
    });
    return res?.result ?? { error: "empty" };
  } catch (e) {
    return { error: "inject", origin: new URL(tab.url).origin, message: String(e.message ?? e) };
  }
}

async function refreshInfo() {
  const r = await getRoom(1);
  el.grant.hidden = r.error !== "inject";
  el.grant.dataset.origin = r.origin ?? "";
  if (r.error === "inject") el.info.textContent = `no access to ${r.origin}`;
  else if (r.error === "no-client") el.info.textContent = "not an Element tab (no Matrix client)";
  else if (r.error === "no-room") el.info.textContent = "open a room";
  else if (r.error) el.info.textContent = r.error;
  else el.info.textContent = `${r.name} (${r.memberCount ?? "?"} members)`;
}

function formatMsg(m) {
  const t = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
  return `[${t}] ${m.sender}: ${m.body}`;
}

function systemPrompt(room, useTools) {
  const base =
    "You are Igor, an assistant living in a sidebar next to the Element (Matrix) chat client. " +
    "Answer questions about the conversation in the current room and help the user think about it. " +
    "Be concise. If the answer is not in the provided messages, say so instead of guessing." +
    (useTools ? " You have tools: use web_search/fetch_url for current or external facts and get_older_messages for earlier room history, only when needed." : "");
  if (!room || room.error) return base;
  const budget = Math.floor(cfg.numCtx * 3 * 0.6);
  const lines = [];
  let used = 0;
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const line = formatMsg(room.messages[i]);
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  return (
    `${base}\n\nThe user is "${room.me}". Current room: "${room.name}"` +
    (room.topic ? ` (topic: ${room.topic})` : "") +
    `.\nMost recent ${lines.length} messages, oldest first:\n\n${lines.join("\n")}`
  );
}

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_OUTPUT = 8000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns titles, URLs and snippets of the top results.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page and return its text content (truncated).",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL" } },
        required: ["url"],
      },
    },
  },
];

async function webSearch(query) {
  const res = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`search blocked or failed (HTTP ${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const results = [...doc.querySelectorAll(".snippet[data-type=web]")].slice(0, 6).map((r) => {
    const title = (r.querySelector(".title") ?? r.querySelector("a"))?.textContent.trim();
    const desc = r.querySelector(".content, .snippet-description, .generic-snippet")?.textContent.trim() ?? "";
    return `${title}\n${r.querySelector("a")?.href}\n${desc}`;
  });
  if (!results.length) throw new Error("search returned no parseable results (possible bot check)");
  return results.join("\n\n");
}

async function fetchUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("html")) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script,style,noscript,nav,footer,svg").forEach((n) => n.remove());
    text = doc.body?.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_OUTPUT);
}

const OLDER_TOOL = {
  type: "function",
  function: {
    name: "get_older_messages",
    description:
      "Back-paginate the current Element room and return messages older than those already in your context. Use when the user asks about earlier discussion you cannot see.",
    parameters: {
      type: "object",
      properties: { count: { type: "number", description: "How many older messages (max 100)" } },
      required: ["count"],
    },
  },
};

async function getOlderMessages(ctx, count) {
  const n = Math.min(Math.max(Math.floor(count) || 50, 1), 100);
  const r = await getRoom(ctx.skip + n);
  if (r.error) throw new Error(r.error);
  const older = r.messages.slice(0, Math.max(0, r.messages.length - ctx.skip));
  ctx.skip += older.length;
  return older.length ? older.map(formatMsg).join("\n") : "No older messages.";
}

async function runTool(name, args, ctx) {
  if (name === "web_search") return webSearch(String(args?.query ?? ""));
  if (name === "fetch_url") return fetchUrl(String(args?.url ?? ""));
  if (name === "get_older_messages" && ctx.room) return getOlderMessages(ctx, Number(args?.count));
  throw new Error(`unknown tool ${name}`);
}

async function streamChat(messages, tools, onText) {
  const res = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: "POST",
    signal: abort.signal,
    body: JSON.stringify({
      model: el.model.value,
      stream: true,
      think: false,
      options: { num_ctx: cfg.numCtx },
      messages,
      ...(tools && { tools }),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`HTTP ${res.status}: ${body}`);
    err.noTools = /does not support tools/i.test(body);
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const p of parts) {
      if (!p.trim()) continue;
      const chunk = JSON.parse(p);
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) {
        content += chunk.message.content;
        onText(content);
      }
      if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
    }
  }
  return { content, toolCalls };
}

async function ask(text) {
  addMsg("user", text);
  history.push({ role: "user", content: text });

  let room = null;
  if (cfg.useCtx) {
    room = await getRoom(cfg.maxMsgs);
    if (room.error) addMsg("error", `No room context (${room.error}); answering without it.`);
  }

  const ctx = { room: room && !room.error ? room : null, skip: room?.messages?.length ?? 0 };
  const tools = [...(cfg.useTools ? TOOLS : []), ...(ctx.room ? [OLDER_TOOL] : [])];

  abort = new AbortController();
  el.send.textContent = "Stop";
  let useTools = tools.length > 0;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let out = null;
      const onText = (t) => {
        out ??= addMsg("assistant", "");
        out.innerHTML = renderMarkdown(t);
        el.log.scrollTop = el.log.scrollHeight;
      };
      let result;
      try {
        result = await streamChat(
          [{ role: "system", content: systemPrompt(room, useTools) }, ...history],
          useTools ? tools : null,
          onText,
        );
      } catch (e) {
        if (e.noTools && useTools) {
          useTools = false;
          addMsg("error", "This model has no tool support; continuing without web tools.");
          round--;
          continue;
        }
        throw e;
      }

      const msg = { role: "assistant", content: result.content };
      if (result.toolCalls.length) msg.tool_calls = result.toolCalls;
      if (result.content || result.toolCalls.length) history.push(msg);
      if (!result.toolCalls.length) return;

      for (const call of result.toolCalls) {
        const { name, arguments: args } = call.function;
        addMsg("tool", `${name}(${JSON.stringify(args)})`);
        let content;
        try {
          content = await runTool(name, args, ctx);
        } catch (e) {
          content = `Error: ${e.message}`;
        }
        history.push({ role: "tool", tool_name: name, content });
      }
    }
    addMsg("error", `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`);
  } catch (e) {
    if (e.name !== "AbortError") addMsg("error", `Request failed: ${e.message}`);
  } finally {
    abort = null;
    el.send.textContent = "Send";
  }
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (abort) return abort.abort();
  const text = el.input.value.trim();
  if (!text || !el.model.value) return;
  el.input.value = "";
  ask(text);
});
el.input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("form").requestSubmit();
  }
});
el.model.addEventListener("change", () => save({ model: el.model.value }));
$("refresh").addEventListener("click", loadModels);
$("clear").addEventListener("click", () => {
  history = [];
  el.log.replaceChildren();
});
$("use-ctx").addEventListener("change", (e) => save({ useCtx: e.target.checked }));
$("use-tools").addEventListener("change", (e) => save({ useTools: e.target.checked }));
$("base-url").addEventListener("change", (e) => {
  save({ baseUrl: e.target.value.replace(/\/+$/, "") });
  loadModels();
});
$("num-ctx").addEventListener("change", (e) => save({ numCtx: Number(e.target.value) || DEFAULTS.numCtx }));
$("max-msgs").addEventListener("change", (e) => save({ maxMsgs: Number(e.target.value) || DEFAULTS.maxMsgs }));
el.grant.addEventListener("click", async () => {
  const origin = el.grant.dataset.origin;
  if (origin && (await chrome.permissions.request({ origins: [`${origin}/*`] }))) refreshInfo();
});

chrome.tabs.onActivated.addListener(refreshInfo);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === "complete") refreshInfo();
});

await loadCfg();
await loadModels();
refreshInfo();

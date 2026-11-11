// Functions of the panel that touch neither the DOM nor extension APIs, so Node tests can import them.

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function formatTime(ts) {
  return new Date(ts).toLocaleString("sv-SE").slice(0, 16);
}

export function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function inlineMarkdown(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "$1<i>$2</i>");
}

// Escaped first, so only the tags added here exist. Links the model writes stay
// plain text: a click on one would send whatever the model put in the URL.
export function markdownToHtml(text) {
  const blocks = [];
  const src = escapeHtml(text.replaceAll("\0", "")).replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_, code) => `\0${blocks.push(code) - 1}\0`);
  const out = [];
  let para = [];
  const lists = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists.at(-1).indent > indent) out.push(`</li></${lists.pop().tag}>`);
  };
  for (const line of src.split("\n")) {
    const item = line.match(/^(\s*)(?:[*+-]|(\d+)[.)])\s+(.*)$/);
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line) || /^\s*\0\d+\0\s*$/.test(line) || /^#{1,6}\s/.test(line)) {
      flush();
      closeLists();
      if (line.includes("\0")) out.push(line.trim());
      else if (line.startsWith("#")) out.push(`<div class="h">${inlineMarkdown(line.replace(/^#+\s+/, ""))}</div>`);
      else out.push("<hr>");
    } else if (item) {
      flush();
      const indent = item[1].replace(/\t/g, "    ").length;
      const tag = item[2] ? "ol" : "ul";
      closeLists(indent);
      const top = lists.at(-1);
      if (top?.indent === indent && top.tag === tag) {
        out.push("</li>");
      } else {
        if (top?.indent === indent) out.push(`</li></${lists.pop().tag}>`);
        out.push(tag === "ol" ? `<ol start="${item[2]}">` : "<ul>");
        lists.push({ tag, indent });
      }
      out.push(`<li>${inlineMarkdown(item[3])}`);
    } else if (!line.trim()) {
      flush();
    } else if (lists.length && /^\s/.test(line)) {
      out.push(`<br>${inlineMarkdown(line.trim())}`);
    } else {
      closeLists();
      para.push(inlineMarkdown(line));
    }
  }
  flush();
  closeLists();
  return out.join("").replace(/\0(\d+)\0/g, (_, i) => `<pre><code>${blocks[i]}</code></pre>`);
}

function replyMarker(m) {
  if (!m.replyTo) return "";
  const who = m.replyToSender;
  const target = m.replyRef ? `[#${m.replyRef}]${who ? ` ${who}` : ""}` : who ? `an earlier message by ${who}` : "an earlier message";
  return ` (replying to ${target})`;
}

export function formatMsg(m) {
  return `${m.ref ? `[#${m.ref}] ` : ""}[${formatTime(m.ts)}] ${m.sender}${replyMarker(m)}: ${m.body}`;
}

function weekStart(m) {
  const d = new Date(m.ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function runsBy(messages, key) {
  const runs = [];
  let last;
  for (const m of messages) {
    const k = key(m);
    if (!runs.length || k !== last) runs.push([]);
    runs.at(-1).push(m);
    last = k;
  }
  return runs;
}

export function messagesSize(messages) {
  return messages.reduce((n, m) => n + formatMsg(m).length, 0);
}

// Calendar weeks, then days, then runs that fit: older parts keep the same
// messages from one run to the next, so their summaries can be cached.
export function splitParts(messages, budget) {
  const lens = new Map(messages.map((m) => [m, formatMsg(m).length]));
  const size = (ms) => ms.reduce((n, m) => n + lens.get(m), 0);
  const keys = [weekStart, (m) => formatTime(m.ts).slice(0, 10)];
  const split = (ms, level) => {
    if (size(ms) <= budget) return [ms];
    if (level < keys.length) return runsBy(ms, keys[level]).flatMap((run) => split(run, level + 1));
    const out = [[]];
    let used = 0;
    for (const m of ms) {
      const len = lens.get(m);
      if (used + len > budget && out.at(-1).length) {
        out.push([]);
        used = 0;
      }
      out.at(-1).push(m);
      used += len;
    }
    return out;
  };
  return split(messages, 0);
}

// This computer and private networks, by address, local-only name, or one of the
// public domains that resolve to the address their name spells out
// (127.0.0.1.nip.io). Any other public name that resolves to a private address
// is not caught.
export function isLocalUrl(url) {
  const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h.includes(":")) return h === "::" || h === "::1" || /^(?:f[cd]|fe[89ab])/.test(h) || h.startsWith("::ffff:");
  if (/^[\d.]+$/.test(h)) {
    return /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  }
  return (
    !h.includes(".") ||
    /\.(?:localhost|local|lan|internal|home\.arpa)$/.test(h) ||
    /(?:^|\.)(?:nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|traefik\.me)$/.test(h)
  );
}

// Why fetch_url must not open a URL, or null. Services on this computer and
// network usually listen on a port of their own; public sites use the default.
export function refusal(url) {
  if (new URL(url).port) return "it names a port, as services on this computer or network usually do";
  return isLocalUrl(url) ? "it points to this computer or a local network" : null;
}

// One button per line: label | period | prompt. Period words: Nd (days),
// unread (since the read marker), mentions (only messages addressed to the user).
export function parseButtons(text) {
  const buttons = [];
  const bad = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [label, period = "", ...rest] = line.split("|").map((s) => s.trim());
    const prompt = rest.join("|");
    const words = period.toLowerCase().split(/\s+/).filter(Boolean);
    if (!label || !prompt || words.some((w) => !/^(?:\d+d|unread|mentions)$/.test(w))) {
      bad.push(label || line.trim());
      continue;
    }
    const days = Number(words.find((w) => /^\d+d$/.test(w))?.slice(0, -1) ?? 0);
    buttons.push({ label, prompt, days, unread: words.includes("unread"), mentions: words.includes("mentions") });
  }
  return { buttons, bad };
}

// Inline on* handlers in fetched pages trip the extension CSP even in an inert
// DOMParser document, so drop them. Only inside tags: page text such as
// "set one = 5" must survive.
export function stripHandlers(html) {
  if (!/on[a-z]+\s*=/i.test(html)) return html;
  return html.replace(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    let first = true;
    return tag.replace(/[\s/]*([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]*))?/g, (attr, name) => {
      if (first) {
        first = false;
        return attr;
      }
      return /^on[a-z]+$/i.test(name) ? "" : attr;
    });
  });
}

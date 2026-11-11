import assert from "node:assert/strict";
const { escapeHtml, isLocalUrl, markdownToHtml, messagesSize, normUrl, parseButtons, refusal, splitParts } = await import("../src/lib.js");

for (const u of [
  "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
  "http://localhost/", "http://localhost./", "http://foo.localhost/", "http://192.168.1.5/", "http://172.20.0.1/",
  "http://10.0.0.1/", "http://100.64.1.1/", "http://169.254.169.254/latest/meta-data", "http://printer.local/",
  "http://metadata.google.internal/", "http://127.0.0.1.nip.io/", "http://0/", "http://[fd00::1]/", "http://[fe80::1]/",
  "http://myhost/",
]) assert.ok(isLocalUrl(u), `${u} should be local`);

for (const u of ["http://example.com/", "https://news.example.org/a?b=1", "http://8.8.8.8/", "https://sub.nip.io.example.com/"]) {
  assert.equal(refusal(u), null, `${u} should be allowed`);
}
assert.match(refusal("https://example.com:8443/"), /port/);
console.log("address guard OK");

assert.equal(normUrl("https://Example.com/a/#frag"), "https://example.com/a");
assert.equal(normUrl("not a url"), null);
console.log("normUrl OK");

assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
const md = markdownToHtml("# Title\n- one\n- two\n\n**bold** *it* `code <b>` <script>alert(1)</script>\n[x](https://evil.example)\n```\nfenced <i>\n```");
assert.ok(!md.includes("<script"), "raw tags are escaped");
assert.ok(!md.includes("<a "), "model-written links stay text");
assert.ok(md.includes("<li>one") && md.includes("<b>bold</b>") && md.includes("<i>it</i>") && md.includes("<code>code &lt;b&gt;</code>"));
assert.ok(md.includes("<pre><code>fenced &lt;i&gt;\n</code></pre>"));
assert.ok(!markdownToHtml("\0" + "0" + "\0").includes("undefined"), "forged placeholders are dropped");
console.log("markdown OK");

const { buttons, bad } = parseButtons("Day | 1d | Summarize {period}\nMentions | 7d mentions | Which need me?\nUnread | unread | What did I miss?\nbroken | 3x | prompt\nno prompt | 1d\n\n");
assert.deepEqual(buttons.map((b) => [b.label, b.days, b.unread, b.mentions]), [["Day", 1, false, false], ["Mentions", 7, false, true], ["Unread", 0, true, false]]);
assert.deepEqual(bad, ["broken", "no prompt"]);
assert.equal(parseButtons("A | | a | b").buttons[0].prompt, "a|b");
console.log("buttons OK");

const day = 86400000;
const t0 = new Date(2026, 9, 5, 9).getTime();
const msgs = Array.from({ length: 60 }, (_, i) => ({ id: `$${i}`, ts: t0 + Math.floor(i / 6) * day + (i % 6) * 60000, sender: "Ana", body: "x".repeat(40) }));
assert.equal(splitParts(msgs, messagesSize(msgs)).length, 1);
const parts = splitParts(msgs, 2000);
assert.ok(parts.length > 1);
assert.deepEqual(parts.flat().map((m) => m.id), msgs.map((m) => m.id), "no message lost or reordered");
for (const p of parts) assert.ok(messagesSize(p) <= 2000 || p.length === 1);
const again = splitParts(msgs.slice(0, 40), 2000);
assert.deepEqual(again[0].map((m) => m.id), parts[0].map((m) => m.id), "older parts stay the same when newer messages are added");
console.log("splitParts OK");
console.log("ALL OK");

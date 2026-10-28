# Igor

Chrome side panel for Element Web: a chat with a local Ollama model that sees the room you have open.

## Setup

1. Ollama must accept extension origins:
   `OLLAMA_ORIGINS=chrome-extension://*` (systemd: `systemctl --user edit ollama`, add under `[Service]`, restart).
2. `chrome://extensions` → Developer mode → Load unpacked → this directory.
3. Open Element Web, click the Igor toolbar icon. Pick a model in the dropdown.

If your Element host is not `app.element.io`, click **Allow this site** in the panel (grants host access at runtime).

## How it works

- Room context comes from Element's own `window.mxMatrixClientPeg` (matrix-js-sdk client), read via a `world: "MAIN"` script injected on each send. Decrypted events work; no second Matrix login. This is an internal global and may change between Element versions.
- The room is taken from the URL hash (`#/room/...`). Older history is back-paginated up to "Max room messages".
- Model list comes from `GET /api/tags`; chat uses `/api/chat` with streaming, `think: false` and an explicit `num_ctx`.

## Tools

The model can call (toggle "Web tools" in the panel; models without tool support fall back automatically):

- `web_search` — Brave Search HTML results, no API key (DuckDuckGo blocks extension requests)
- `fetch_url` — page text, truncated to 8k chars
- `get_older_messages` — back-paginates the room via the Matrix client for history beyond the initial window

The extension requests `https://*/*` host access so `fetch_url` and Element on any host work.

## Layout

- `src/panel.*` — side panel UI
- `src/extract.js` — room extraction (injected into the page)
- `src/background.js` — opens the panel on icon click

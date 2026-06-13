# CLAUDE.md — project context for Claude Code

## What this is
A self-serve web app that generates pharmaceutical "intelligence reports". A
customer uploads a brand logo, types a brand name and one or more drug
compositions (e.g. "Acebrophylline 200 SR", "Montelukast + Bilastine"), and the
app uses the **Google Gemini API** to write a full styled portfolio report:
executive summary, per-composition deep dives (overview, identity table,
mechanism of action, clinical utility, safety incl. boxed warnings,
comparison-vs-alternatives table, positioning case), portfolio logic, market
landscape, and strategic outlook. The result renders as printable A4 pages and
exports to PDF via the browser print dialog.

## Architecture
- **Backend** (`server.js`): Node + Express, no SDK (plain `fetch`). Serves the
  static frontend and exposes `POST /api/generate`, which forwards `{system, user,
  web}` to the Gemini `generateContent` endpoint
  (`https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent`)
  using `x-goog-api-key`. It normalizes Gemini's response to
  `{ content: [{ type:'text', text }] }` so the frontend stays provider-agnostic.
  Also `GET /api/config` and `GET /api/health`.
- **Frontend** (`public/index.html`): single self-contained file (HTML+CSS+JS, no
  framework, no build). Collects inputs, runs several sequential calls to
  `/api/generate` (frame -> each composition -> portfolio -> market+outlook), each
  returning strict JSON, then renders and offers Print / Save as PDF + a
  per-section Regenerate button. Logo is embedded in-browser, never uploaded.

## Key behaviours
- The Gemini API key lives ONLY in the backend env (`GEMINI_API_KEY`).
- `web !== false` -> Google Search grounding tool `[{ google_search: {} }]`.
  When grounding is on, JSON mode is NOT set (tools + responseMimeType conflict),
  so the prompt asks for JSON-only and the frontend parses defensively.
  When grounding is off, `generationConfig.responseMimeType = "application/json"`.
- `GEMINI_MODEL` env switches the model (default `gemini-2.5-flash`).
- Generated content is directional commercial intelligence, not regulatory,
  medical, or financial advice — the report footer states this.

## Run locally
1. `npm install`
2. `cp .env.example .env` then set `GEMINI_API_KEY`
3. `npm start` -> http://localhost:3000

## Common tasks
- Add a "regenerate just this section" button (already present) or per-paragraph.
- Move orchestration server-side into one `/api/report` endpoint.
- Add a responseSchema for strict structured output (ungrounded mode).
- Swap models via `GEMINI_MODEL`; add provider switch back to Anthropic.
- Add usage logging / rate limiting / caching.

## Deploy
Any host running a persistent Node process with env vars: Render (see
`render.yaml`), Railway, Fly.io, a VPS.

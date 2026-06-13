# Pharma Report Generator (Gemini)

A self-serve web app: a customer uploads a logo, types a brand name and the drug
compositions, clicks **Generate report**, and Google Gemini writes a full styled
portfolio report (pharmacology, comparison tables, market landscape, strategy)
that they can save as PDF.

Frontend + backend included. Your **Gemini API key stays on the server** and is
never exposed to the browser.

**Features:** drag-and-drop logo, brand + composition inputs, full AI-written
report, live web grounding (Google Search) for current data, **Save as PDF**,
a **Regenerate** button on each section, and an optional access code.

```
pharma-report-generator/
├── server.js            # Express backend: serves the app + /api/generate (calls Gemini)
├── public/index.html    # the whole frontend (no build step)
├── package.json
├── .env.example         # copy to .env and add your key
├── render.yaml          # one-click Render Blueprint
├── CLAUDE.md            # context for Claude Code
└── README.md
```

---

## Run it (locally or via Claude Code)

1. `npm install`
2. `cp .env.example .env`  then put your key in `GEMINI_API_KEY`
   (get one at https://aistudio.google.com/apikey)
3. `npm start`  ->  open http://localhost:3000

In Claude Code you can just say: *"install dependencies, create my .env from the
example, and start the dev server."*

---

## Put it online (always on, no PC needed)

### Render (recommended) — uses the included `render.yaml`
1. Push this folder to a GitHub repo.
2. https://render.com -> **New -> Blueprint** -> connect the repo.
3. When prompted, paste your `GEMINI_API_KEY` (and optional `ACCESS_CODE`).
4. Deploy. You get a public URL you can share with any customer, on any device.

Railway / Fly.io work the same way: connect the repo, set `GEMINI_API_KEY`, deploy.

---

## Live internet data (web grounding)
By default the app uses Google Search grounding so each section is written from
current web data (pharmacology, present-day brand landscape, recent safety
updates). The customer can untick "Fetch composition data live from the internet"
for a faster, ungrounded draft (which also forces strict JSON for max reliability).

---

## Settings (environment variables)

| Variable         | Required | Purpose                                                        |
|------------------|----------|----------------------------------------------------------------|
| `GEMINI_API_KEY` | yes      | Your Gemini key. Lives only on the server.                     |
| `GEMINI_MODEL`   | no       | Default `gemini-2.5-flash`. Lighter: `gemini-2.5-flash-lite`. Stronger: `gemini-2.5-pro`. |
| `PORT`           | no       | Local port, defaults to `3000`.                                |
| `ACCESS_CODE`    | no       | If set, visitors must enter this code. Blank = open tool.      |

## Cost & free tier
Gemini has a free tier (Google AI Studio keys, no billing enabled). Watch two things:
- **Free-tier data policy:** Google may use free-tier inputs/outputs to improve
  their models. For confidential client data, use a paid/Vertex key instead.
- **Daily caps:** the free tier has per-minute and per-day request limits, so a
  public, high-traffic page may hit them. Each report is ~6 calls.
- Enabling billing on a Gemini project removes the free tier on that project
  (all calls become billable). Set a spend cap if you go paid.

## Notes
- The customer's logo is read in their browser and embedded into the report; it
  is not stored server-side.
- Output is directional commercial intelligence — not regulatory, medical, or
  financial advice (stated in the report footer).

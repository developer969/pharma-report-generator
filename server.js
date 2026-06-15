// Pharma Report Generator — backend (Google Gemini)
// Serves the frontend and exposes one proxy endpoint that calls the Gemini API.
// Your GEMINI_API_KEY stays here on the server, never in the browser.

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-flash-lite"; // less-congested fallback under load
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const API_KEY = process.env.GEMINI_API_KEY || "";
const endpointFor = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A transient overload / server error that's worth retrying.
function isRetryable(status, bodyText) {
  if (status === 429 || status === 500 || status === 503) return true;
  const b = (bodyText || "").toLowerCase();
  return b.includes("overloaded") || b.includes("high demand") || b.includes("unavailable");
}

app.get("/api/config", (_req, res) => res.json({ requireCode: !!ACCESS_CODE }));
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, provider: "gemini", model: MODEL, keyConfigured: !!API_KEY })
);

// One raw request to a specific model. Returns the model's text output, or throws
// an Error carrying { status, retryable } so callers can decide to back off.
async function rawGemini({ system, user, grounded, model }) {
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0.4 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (grounded) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = "application/json";

  const r = await fetch(endpointFor(model), {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  const rawBody = await r.text();
  let data = {};
  try { data = rawBody ? JSON.parse(rawBody) : {}; } catch { data = {}; }
  if (!r.ok || data.error) {
    const msg = data?.error?.message || `Gemini error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.retryable = isRetryable(r.status, rawBody);
    throw err;
  }
  const cand = data.candidates && data.candidates[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason || "no text returned";
    const err = new Error(`Empty response from model (${reason})`);
    err.status = 502;
    err.retryable = false;
    throw err;
  }
  return text;
}

// Exponential backoff with jitter (~1s, 2s, 4s, 8s + up to ~500ms) on transient
// overload/5xx — up to 5 attempts on the given model.
async function callGeminiWithRetry({ system, user, grounded, model }) {
  const delays = [1000, 2000, 4000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawGemini({ system, user, grounded, model });
    } catch (e) {
      if (!e.retryable || attempt >= delays.length) throw e;
      await sleep(delays[attempt] + Math.floor(Math.random() * 500));
    }
  }
}

// Retry on the primary model; if it's still overloaded after all attempts, fall
// back once to the lighter model. grounded=true adds Google Search; grounded=false
// forces JSON.
async function callGemini({ system, user, grounded }) {
  try {
    return await callGeminiWithRetry({ system, user, grounded, model: MODEL });
  } catch (e) {
    if (e.retryable && MODEL !== FALLBACK_MODEL) {
      return await rawGemini({ system, user, grounded, model: FALLBACK_MODEL });
    }
    throw e;
  }
}

// ---- robust JSON handling -------------------------------------------------
// Pull a JSON object out of the model's text: drop code fences, then take from
// the first "{" to the last "}". Throws if what's left isn't valid JSON.
function extractJson(text) {
  let t = String(text == null ? "" : text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// Fields the frontend iterates with .map(); force them to arrays wherever they
// appear in the tree so a stray string/object can never crash rendering.
const ARRAY_FIELDS = new Set([
  "scope", "executiveSummary", "moleculeBlurbs", "overview", "identity",
  "pathways", "points", "clinicalUtility", "columns", "rows", "values",
  "prescriberPoints", "fdcs", "brandTables", "outlook", "sources",
]);
const toArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
function coerceShape(node) {
  if (Array.isArray(node)) return node.map(coerceShape);
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      node[k] = ARRAY_FIELDS.has(k) ? toArr(node[k]).map(coerceShape) : coerceShape(node[k]);
    }
  }
  return node;
}

// One section, returned as a clean shape-normalised object: fall back from
// grounded→ungrounded on API error, then retry once on malformed JSON.
async function generateSection({ system, user, grounded }) {
  let text;
  try {
    text = await callGemini({ system, user, grounded });
  } catch (e1) {
    // If grounding isn't available (e.g. free-tier limits), fall back ungrounded
    // so the customer still gets a report instead of a hard failure.
    if (grounded) text = await callGemini({ system, user, grounded: false });
    else throw e1;
  }
  try {
    return coerceShape(extractJson(text));
  } catch {
    const strictUser =
      user + "\n\nReturn ONLY a valid JSON object. No markdown, no prose, no code fences.";
    return coerceShape(extractJson(await callGemini({ system, user: strictUser, grounded })));
  }
}

app.post("/api/generate", async (req, res) => {
  if (ACCESS_CODE && (req.headers["x-access-code"] || "") !== ACCESS_CODE) {
    return res.status(401).json({ error: { message: "Invalid or missing access code." } });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: { message: "GEMINI_API_KEY is not set on the server." } });
  }
  const { system, user, web } = req.body || {};
  if (!user) return res.status(400).json({ error: { message: "Missing 'user' prompt." } });

  const wantGrounded = web !== false;
  try {
    const obj = await generateSection({ system, user, grounded: wantGrounded });
    // Return clean, normalised JSON as text — the shape the frontend expects.
    res.json({ content: [{ type: "text", text: JSON.stringify(obj) }] });
  } catch (e) {
    res.status(e?.status || 500).json({ error: { message: e?.message || String(e) } });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Report app (Gemini) running on http://localhost:${PORT}`));

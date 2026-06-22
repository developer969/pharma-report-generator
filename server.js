// Pharma Report Generator — backend (Google Gemini)
// Serves the frontend and exposes one proxy endpoint that calls the Gemini API.
// Your GEMINI_API_KEY stays here on the server, never in the browser.

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-flash-lite"; // less-congested fallback under load
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const API_KEY = process.env.GEMINI_API_KEY || "";

// ---- Supabase auth (Stage 2) ----------------------------------------------
// Validate the logged-in user's token server-side. The publishable key is safe
// here (same one the browser uses); it only lets us verify tokens, not bypass RLS.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://nvkihbdofkutxbgpbnqg.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_fJbgzYRfDz2hCGbqw5GB9g_LYIj5CkA";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Admin client (secret key) — bypasses Row Level Security to read/update the
// profiles table for metering. SUPABASE_SECRET_KEY is server-only and must never
// reach the browser. Set it (and SUPABASE_URL) as env vars on the host.
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
// Built only when the secret key is present, so a host that hasn't set it yet
// still boots (metered requests then get a clear 500 — see /api/generate).
const admin = SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// Verify the Bearer token from the Authorization header. Returns the Supabase
// user on success; on a missing/invalid token it sends a 401 and returns null
// (callers must stop when they get null).
async function requireUser(req, res) {
  const authz = req.headers["authorization"] || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: { message: "Authentication required — please log in." } });
    return null;
  }
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: { message: "Session expired or invalid — please log in again." } });
      return null;
    }
    return data.user;
  } catch {
    res.status(401).json({ error: { message: "Could not verify your session — please log in again." } });
    return null;
  }
}
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
  // Require a valid logged-in Supabase user (sends 401 itself if not).
  const authedUser = await requireUser(req, res);
  if (!authedUser) return;
  // Optional access-code gate still applies on top, when configured.
  if (ACCESS_CODE && (req.headers["x-access-code"] || "") !== ACCESS_CODE) {
    return res.status(401).json({ error: { message: "Invalid or missing access code." } });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: { message: "GEMINI_API_KEY is not set on the server." } });
  }
  const { system, user, web, meter } = req.body || {};
  if (!user) return res.status(400).json({ error: { message: "Missing 'user' prompt." } });

  // ---- metering (Stage 2 paywall): 1 free report, then 1 credit = 1 report ----
  // The frontend marks only the first section of a report run with meter:true, so
  // a whole report is charged exactly once; later sections and "Regenerate" calls
  // come through without meter and pass straight to generation.
  let meterProfile = null, meterUsesFree = false;
  if (meter === true) {
    if (!admin) {
      return res.status(500).json({ error: { message: "Server missing SUPABASE_SECRET_KEY." } });
    }
    // Read the caller's profile with the admin (secret-key) client, which bypasses
    // RLS — so it never depends on a user policy the way the browser's own read does.
    let { data: profile, error: profileErr } = await admin
      .from("profiles").select("free_used, credits").eq("id", authedUser.id).maybeSingle();

    // No row yet (e.g. the signup trigger never ran) → create one and treat it as a
    // fresh profile so the first report still works.
    if (!profileErr && !profile) {
      const { data: created, error: insertErr } = await admin
        .from("profiles")
        .insert({ id: authedUser.id, email: authedUser.email })
        .select("free_used, credits")
        .single();
      if (insertErr) {
        return res.status(500).json({ error: { message: "Could not create profile: " + insertErr.message } });
      }
      profile = created;
    }

    if (profileErr || !profile) {
      // Surface the real reason — a permission error here means the configured key
      // isn't actually the secret key (RLS is still being enforced).
      return res.status(500).json({ error: { message: "Profile lookup failed" + (profileErr ? ": " + profileErr.message : "") } });
    }
    const canUseFree = profile.free_used === false;
    const hasCredit = profile.credits > 0;
    if (!canUseFree && !hasCredit) {
      return res.status(402).json({ error: { message: "No reports left" }, needsPayment: true });
    }
    meterProfile = profile;
    meterUsesFree = canUseFree;
  }

  const wantGrounded = web !== false;
  try {
    const obj = await generateSection({ system, user, grounded: wantGrounded });
    // Consume one report only after a successful generation, so a failed Gemini
    // call never costs the customer a report.
    if (meter === true && meterProfile) {
      if (meterUsesFree) {
        await admin.from("profiles").update({ free_used: true }).eq("id", authedUser.id);
      } else {
        await admin.from("profiles").update({ credits: meterProfile.credits - 1 }).eq("id", authedUser.id);
      }
    }
    // Return clean, normalised JSON as text — the shape the frontend expects.
    res.json({ content: [{ type: "text", text: JSON.stringify(obj) }] });
  } catch (e) {
    res.status(e?.status || 500).json({ error: { message: e?.message || String(e) } });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Report app (Gemini) running on http://localhost:${PORT}`);
  // Metering config check — reports detection status only, never the key itself.
  const looksSecret = SUPABASE_SECRET_KEY.startsWith("sb_secret_");
  const keyStatus = !SUPABASE_SECRET_KEY
    ? "MISSING — metering will return 500 (set it on the host)"
    : looksSecret
      ? "detected (sb_secret_…)"
      : "detected but NOT an sb_secret_ key — RLS will still apply and profile reads will fail";
  console.log(
    `[config] SUPABASE_URL: ${process.env.SUPABASE_URL ? "from env" : "using default"} | ` +
    `SUPABASE_SECRET_KEY: ${keyStatus}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Sage Companion LLC — Server
// Stack: Express + Supabase (PostgreSQL) + Anthropic Claude
// Run: node server.js
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express    = require("express");
const path       = require("path");
const crypto     = require("crypto");
const { v4: uuidv4 } = require("uuid");
const Anthropic  = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const multer     = require("multer");
const { google } = require("googleapis");
const webpush    = require("web-push");
const cron       = require("node-cron");
const Stripe     = require("stripe");
const { Resend } = require("resend");
const https      = require("https");

// ── Multer (image uploads — memory only) ─────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL             || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// ── Stripe (payments) ─────────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_MONTHLY  = process.env.STRIPE_PRICE_MONTHLY  || ""; // Stripe Price ID for $9.99/mo
const STRIPE_PRICE_YEARLY   = process.env.STRIPE_PRICE_YEARLY   || ""; // Stripe Price ID for $89.99/yr

// ── Resend (transactional email) ──────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || "Sage Companion <hello@mysagecompanion.com>";

// ── Demo senior ID ────────────────────────────────────────────────────────────
const DEMO_SENIOR_ID = "00000000-0000-0000-0000-000000000001";

// ── Production safety checks ─────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
if (IS_PROD) {
  const missing = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "sage-family-secret-dev") missing.push("JWT_SECRET");
  if (!process.env.SENIOR_TOKEN_SECRET || process.env.SENIOR_TOKEN_SECRET === "sage-senior-secret-dev") missing.push("SENIOR_TOKEN_SECRET");
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "admin123") missing.push("ADMIN_PASSWORD");
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    console.error("🚨 FATAL: Missing required production environment variables:", missing.join(", "));
    console.error("   Set these in Railway → Variables before deploying.");
    process.exit(1);
  }
  console.log("✅ Production secret check passed");
}

// ── Web Push (VAPID) setup ────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL   = process.env.VAPID_EMAIL        || "mailto:hello@mysagecompanion.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fields that should NEVER be sent to the client
const SENSITIVE_FIELDS = ["password_hash", "passwordHash", "google_tokens", "googleTokens",
  "supabase_service_role_key", "stripe_customer_id", "stripeCustomerId"];

// Strip sensitive fields from a senior record before sending to client
function safeSenior(obj) {
  if (!obj) return null;
  const out = { ...obj };
  for (const f of SENSITIVE_FIELDS) delete out[f];
  return out;
}

// Convert snake_case Supabase rows → camelCase + add _id alias for frontend
function toCamel(obj) {
  if (!obj) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[ck] = v;
  }
  out._id = obj.id;
  return out;
}

const norm    = toCamel;
const normArr = (rows) => (rows || []).map(toCamel);

// Update last_active and increment daily usage counter
async function trackUsage(seniorId, field) {
  try {
    await supabase.from("seniors")
      .update({ last_active: new Date().toISOString() })
      .eq("id", seniorId);
    if (field) {
      const today = new Date().toISOString().split("T")[0];
      await supabase.rpc("increment_usage", {
        p_senior_id: seniorId,
        p_date: today,
        p_field: field,
      });
    }
  } catch (e) { /* non-critical — don't fail the request */ }
}

// ── Cost tracking helpers ────────────────────────────────────────────────────

// Pricing per 1M tokens (as of 2025 — update if models change)
const MODEL_PRICING = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00 },
  "claude-opus-4-5-20251101":  { input: 15.00, output: 75.00 },
};
// OpenAI TTS pricing per 1M characters
const TTS_PRICING = {
  "gpt-4o-mini-tts": 12.00,  // $12/1M chars
  "tts-1":           15.00,
  "tts-1-hd":        30.00,
};

async function logCost(seniorId, callType, model, inputTokens, outputTokens, ttsChars) {
  try {
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-haiku-4-5-20251001"];
    let cost = ((inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output) / 1_000_000;
    if (ttsChars && ttsChars > 0) {
      const ttsModel = (process.env.TTS_MODEL || "gpt-4o-mini-tts").trim();
      const ttsPricing = TTS_PRICING[ttsModel] || TTS_PRICING["gpt-4o-mini-tts"];
      cost += (ttsChars * ttsPricing) / 1_000_000;
    }
    const today = new Date().toISOString().split("T")[0];
    await supabase.from("cost_log").insert({
      senior_id: seniorId,
      date: today,
      call_type: callType,
      model: model || "unknown",
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
      tts_chars: ttsChars || 0,
      cost_usd: Math.round(cost * 1_000_000) / 1_000_000, // 6 decimal places
    });
  } catch (e) { /* non-critical */ }
}

// ── Long-term memory helpers ──────────────────────────────────────────────────

// Skip extraction for short/trivial messages (saves an API call ~80% of the time)
const SKIP_EXTRACTION_PATTERNS = /^(ok|okay|yes|no|yeah|yep|nope|sure|thanks|thank you|got it|good|great|bye|hi|hello|hey|alright|fine|cool|hm+|ah+|oh+|hmm+|right|yea)\b/i;
const MIN_EXTRACTION_LENGTH = 25; // messages shorter than this rarely contain facts

function calculateSimilarity(str1, str2) {
  const words = (s) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const a = words(str1), b = words(str2);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

async function deduplicateAndSave(seniorId, category, text, existingByCategory) {
  try {
    // Use pre-fetched category data if available (avoids extra DB call)
    let existing = existingByCategory;
    if (!existing) {
      const { data } = await supabase
        .from("memories")
        .select("id, memory_text, mention_count")
        .eq("senior_id", seniorId)
        .eq("category", category);
      existing = data || [];
    }

    const similar = existing.find(m => calculateSimilarity(m.memory_text, text) > 0.6);

    if (similar) {
      await supabase.from("memories").update({
        last_mentioned: new Date().toISOString(),
        mention_count: similar.mention_count + 1,
      }).eq("id", similar.id);
    } else if (existing.length >= 30) {
      // At cap — replace the oldest, least-mentioned memory
      const weakest = existing.sort((a, b) => a.mention_count - b.mention_count)[0];
      if (weakest) {
        await supabase.from("memories").update({
          category,
          memory_text: text,
          mention_count: 1,
          last_mentioned: new Date().toISOString(),
        }).eq("id", weakest.id);
      }
    } else {
      await supabase.from("memories").insert({
        senior_id: seniorId,
        category,
        memory_text: text,
      });
    }
  } catch (e) { console.error("[Memory] dedup error:", e.message); }
}

async function extractMemories(seniorId, userMessage, aiReply) {
  const trimmed = (userMessage || "").trim();
  // Skip trivial messages — no API call needed
  if (trimmed.length < MIN_EXTRACTION_LENGTH) return;
  if (SKIP_EXTRACTION_PATTERNS.test(trimmed)) return;
  // Skip pure questions with no personal info (e.g. "what's the weather?")
  if (trimmed.length < 60 && /^(what|when|where|how|can you|will you|is it|are there|do you|does|did)\b/i.test(trimmed) && !/\b(my|i|i'm|i've|i'd|me|mine)\b/i.test(trimmed)) return;

  try {
    // Pre-fetch ALL memories for this senior in one query (instead of per-category)
    const { data: allExisting } = await supabase
      .from("memories")
      .select("id, category, memory_text, mention_count")
      .eq("senior_id", seniorId);
    const byCategory = {};
    for (const m of (allExisting || [])) {
      if (!byCategory[m.category]) byCategory[m.category] = [];
      byCategory[m.category].push(m);
    }

    const memModel = process.env.CHAT_MODEL || "claude-haiku-4-5-20251001";
    const extraction = await anthropic.messages.create({
      model: memModel,
      max_tokens: 300,
      system: "Extract personal facts about the senior from this conversation. Return a JSON array only. Be selective — only extract clear, meaningful facts.",
      messages: [{
        role: "user",
        content: `Extract personal facts about the senior from this conversation snippet.
Categories: family, hobby, health, preference, life_event, concern, routine
Return JSON array: [{"category":"family","text":"Grandson Tommy plays soccer"}]
Only extract clear facts explicitly stated by the senior. Skip greetings, questions, and vague statements. If none, return [].

Senior said: "${trimmed}"
Sage replied: "${aiReply.slice(0, 200)}"`,
      }],
    });

    // Log memory extraction cost (non-blocking)
    const memTokens = extraction.usage || {};
    logCost(seniorId, "memory_extraction", memModel, memTokens.input_tokens, memTokens.output_tokens, 0).catch(() => {});

    const raw = extraction.content[0]?.text || "[]";
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;
    const memories = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(memories)) return;

    const validCategories = new Set(["family", "hobby", "health", "preference", "life_event", "concern", "routine"]);
    for (const mem of memories.slice(0, 5)) {
      if (mem.category && mem.text && validCategories.has(mem.category) && mem.text.length > 5 && mem.text.length < 200) {
        await deduplicateAndSave(seniorId, mem.category, mem.text, byCategory[mem.category] || []);
      }
    }
  } catch (e) { console.error("[Memory] extraction error:", e.message); }
}

async function getRelevantMemories(seniorId, limit = 15) {
  try {
    // Score = mention_count + recency bonus (memories mentioned recently rank higher)
    const { data, error } = await supabase
      .from("memories")
      .select("category, memory_text, mention_count, last_mentioned")
      .eq("senior_id", seniorId)
      .order("last_mentioned", { ascending: false })
      .limit(50); // fetch more, then rank client-side
    if (error) { console.error("[Memory] retrieval DB error:", error.message); return ""; }
    if (!data || data.length === 0) return "";

    // Score: mention_count + recency bonus (0-5 points for last 7 days)
    const now = Date.now();
    const scored = data.map(m => {
      const ageMs = now - new Date(m.last_mentioned || 0).getTime();
      const ageDays = ageMs / 86400000;
      const recencyBonus = ageDays < 1 ? 5 : ageDays < 3 ? 3 : ageDays < 7 ? 1 : 0;
      return { ...m, score: (m.mention_count || 1) + recencyBonus };
    });
    scored.sort((a, b) => b.score - a.score);

    // Group by category for organized display
    const grouped = {};
    for (const m of scored.slice(0, limit)) {
      const cat = m.category || "general";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(m.memory_text);
    }

    const categoryLabels = {
      family: "Family & relationships",
      hobby: "Hobbies & interests",
      health: "Health notes",
      preference: "Preferences",
      life_event: "Life events",
      concern: "Current concerns",
      routine: "Daily routine",
    };

    return Object.entries(grouped).map(([cat, items]) => {
      const label = categoryLabels[cat] || cat;
      return `${label}: ${items.join("; ")}`;
    }).join("\n");
  } catch (e) {
    console.error("[Memory] retrieval error:", e.message);
    return "";
  }
}

// ── Admin auth ────────────────────────────────────────────────────────────────
function adminToken() {
  return crypto
    .createHash("sha256")
    .update((process.env.ADMIN_PASSWORD || "admin123") + "sage-admin-salt")
    .digest("hex");
}

function adminAuth(req, res, next) {
  if (req.headers["x-admin-token"] !== adminToken()) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Family auth (HMAC token tied to seniorId) ─────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "sage-family-secret-dev";
const FAMILY_TOKEN_DAYS = 30;

function makeFamilyToken(seniorId) {
  const iat = Date.now();
  const exp = iat + FAMILY_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ seniorId, iat, exp, type: "family" })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyFamilyToken(token) {
  try {
    const [payload, sig] = (token || "").split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp && data.exp < Date.now()) return null; // expired
    return data;
  } catch { return null; }
}

function familyAuth(req, res, next) {
  const token = req.headers["x-family-token"];
  const payload = verifyFamilyToken(token);
  if (!payload) return res.status(401).json({ error: "Family authentication required" });
  req.seniorId = payload.seniorId;
  next();
}

// ── Senior auth (long-lived 90-day tokens for elderly users) ──────────────────
const SENIOR_TOKEN_SECRET = process.env.SENIOR_TOKEN_SECRET || "sage-senior-secret-dev";
const SENIOR_TOKEN_DAYS = 90;

function makeSeniorToken(seniorId) {
  const iat = Date.now();
  const exp = iat + SENIOR_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ seniorId, iat, exp, type: "senior" })).toString("base64url");
  const sig = crypto.createHmac("sha256", SENIOR_TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// ── Calendar feed token (non-expiring, for webcal:// subscriptions) ──────────
function makeCalendarFeedToken(seniorId) {
  const payload = Buffer.from(JSON.stringify({ seniorId, type: "calendar_feed" })).toString("base64url");
  const sig = crypto.createHmac("sha256", SENIOR_TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifyCalendarFeedToken(token) {
  try {
    const [payload, sig] = (token || "").split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", SENIOR_TOKEN_SECRET).update(payload).digest("hex");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.type !== "calendar_feed") return null;
    return data; // no expiry check — feed tokens are permanent
  } catch { return null; }
}

function verifySeniorToken(token) {
  try {
    const [payload, sig] = (token || "").split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", SENIOR_TOKEN_SECRET).update(payload).digest("hex");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function seniorAuth(req, res, next) {
  // Allow demo senior through without a token
  const seniorId = req.params.seniorId || req.body?.seniorId;
  if (seniorId === DEMO_SENIOR_ID) { req.seniorId = DEMO_SENIOR_ID; return next(); }

  const token = req.headers["x-senior-token"];
  const payload = verifySeniorToken(token);
  if (!payload) {
    console.log(`[Auth] seniorAuth REJECTED — path: ${req.path}, hasToken: ${!!token}, tokenPreview: ${token ? token.substring(0, 20) : "NONE"}`);
    return res.status(401).json({ error: "Please log in to continue" });
  }
  req.seniorId = payload.seniorId;
  next();
}

// Middleware to check if user is suspended (used on key endpoints only)
async function suspendCheck(req, res, next) {
  try {
    const { data } = await supabase.from("seniors").select("suspended").eq("id", req.seniorId).single();
    if (data?.suspended) {
      return res.status(403).json({ error: "Your account has been suspended. Please contact support@mysagecompanion.com." });
    }
  } catch (e) { console.error("[Auth] suspendCheck error:", e.message); }
  next();
}

// ── Auth that accepts EITHER senior or family tokens ──────────────────────────
function anyAuth(req, res, next) {
  const seniorId = req.params.seniorId || req.body?.seniorId;
  if (seniorId === DEMO_SENIOR_ID) { req.seniorId = DEMO_SENIOR_ID; return next(); }

  const sToken = req.headers["x-senior-token"];
  const fToken = req.headers["x-family-token"];
  const sPayload = verifySeniorToken(sToken);
  const fPayload = verifyFamilyToken(fToken);
  if (sPayload) { req.seniorId = sPayload.seniorId; return next(); }
  if (fPayload) { req.seniorId = fPayload.seniorId; return next(); }
  return res.status(401).json({ error: "Authentication required" });
}

// ── UUID validation ───────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUUID(...paramNames) {
  return (req, res, next) => {
    for (const p of paramNames) {
      const val = req.params[p] || req.body?.[p];
      if (val && !UUID_RE.test(val)) {
        return res.status(400).json({ error: `Invalid ${p} format` });
      }
    }
    next();
  };
}

// ── Medication reminder cron (runs every minute) ──────────────────────────────
// IMPORTANT: Server runs in UTC. Medication times are stored in the user's local
// timezone (e.g. "8:00 AM" means 8 AM in their zone). We must convert "now" to
// each user's timezone before comparing, otherwise reminders fire at UTC times.
async function checkMedicationReminders() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // Push not configured
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL === "YOUR_SUPABASE_PROJECT_URL") return;

  try {
    const now = new Date();

    // Get ALL active medications with their senior's timezone
    const { data: allMeds } = await supabase
      .from("medications")
      .select("id, name, dose, senior_id, time, med_times, seniors!inner(timezone)")
      .eq("active", true);

    if (!allMeds || !allMeds.length) return;

    // Group meds by senior_id so we compute each user's local time once
    const bySenior = {};
    for (const med of allMeds) {
      if (!bySenior[med.senior_id]) bySenior[med.senior_id] = { tz: med.seniors?.timezone, meds: [] };
      bySenior[med.senior_id].meds.push(med);
    }

    const dueMeds = [];
    for (const [seniorId, group] of Object.entries(bySenior)) {
      // Compute current time in the user's timezone (fall back to America/New_York)
      const tz = group.tz || "America/New_York";
      let localTime;
      try {
        localTime = now.toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
        }); // e.g. "8:00 AM"
      } catch {
        localTime = now.toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
        });
      }

      for (const med of group.meds) {
        let times;
        try { times = med.med_times ? JSON.parse(med.med_times) : null; } catch { times = null; }
        if (!times || !Array.isArray(times) || times.length === 0) {
          times = med.time ? [med.time] : [];
        }
        if (times.includes(localTime)) {
          dueMeds.push({ ...med, doseTime: localTime, tz });
        }
      }
    }

    if (!dueMeds.length) return;

    for (const med of dueMeds) {
      // Compute "today" start in the user's timezone for the taken-check
      let todayStart;
      try {
        const todayLocal = now.toLocaleDateString("en-CA", { timeZone: med.tz }); // "YYYY-MM-DD"
        const localNow = new Date(now.toLocaleString("en-US", { timeZone: med.tz }));
        const offsetMs = localNow.getTime() - now.getTime();
        todayStart = new Date(new Date(`${todayLocal}T00:00:00`).getTime() - offsetMs).toISOString();
      } catch {
        todayStart = now.toISOString().split("T")[0] + "T00:00:00.000Z";
      }

      const todayTag = now.toLocaleDateString("en-CA", { timeZone: med.tz || "America/New_York" });

      // Skip if this specific dose_time already taken today
      const { count: taken } = await supabase
        .from("med_log")
        .select("*", { count: "exact", head: true })
        .eq("senior_id", med.senior_id)
        .eq("medication_id", med.id)
        .eq("dose_time", med.doseTime)
        .gte("taken_at", todayStart);

      if (taken > 0) continue;

      // Get all push subscriptions for this senior
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, subscription_json")
        .eq("senior_id", med.senior_id);

      for (const sub of (subs || [])) {
        try {
          await webpush.sendNotification(
            JSON.parse(sub.subscription_json),
            JSON.stringify({
              title:        "💊 Time for your medication",
              body:         `It's time to take ${med.name}${med.dose ? " (" + med.dose + ")" : ""} — ${med.doseTime} dose`,
              icon:         "/icons/icon-192.png",
              badge:        "/icons/badge-72.png",
              tag:          `med-${med.id}-${med.doseTime.replace(/\s/g,"")}-${todayTag}`,
              medicationId: med.id,
              seniorId:     med.senior_id,
              doseTime:     med.doseTime,
            })
          );
          await supabase.from("push_subscriptions")
            .update({ last_used: new Date().toISOString() })
            .eq("id", sub.id);
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }
    }
  } catch (e) {
    console.error("[MedReminder] Check error:", e.message);
  }
}

// ── Prescription refill reminder (runs daily at 9 AM via cron) ────────────────
async function checkRefillReminders() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL === "YOUR_SUPABASE_PROJECT_URL") return;

  try {
    const today = new Date().toISOString().split("T")[0];
    // Find meds with next_refill within the next 7 days or overdue
    const sevenDaysOut = new Date();
    sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
    const cutoff = sevenDaysOut.toISOString().split("T")[0];

    const { data: meds } = await supabase
      .from("medications")
      .select("id, name, dose, senior_id, next_refill, refills_remaining")
      .eq("active", true)
      .not("next_refill", "is", null)
      .lte("next_refill", cutoff);

    if (!meds || !meds.length) return;

    for (const med of meds) {
      const daysUntil = Math.ceil((new Date(med.next_refill) - new Date(today)) / (1000*60*60*24));

      // Only notify at specific intervals: overdue, today, 3 days, 7 days
      if (daysUntil !== 0 && daysUntil !== 3 && daysUntil !== 7 && daysUntil >= 0) continue;

      const tag = `refill-${med.id}-${today}`;

      // Check if we already sent this alert today
      const { count } = await supabase
        .from("activity")
        .select("*", { count: "exact", head: true })
        .eq("senior_id", med.senior_id)
        .eq("type", "refill_reminder")
        .gte("timestamp", today + "T00:00:00.000Z")
        .ilike("description", `%${med.name}%`);

      if (count > 0) continue;

      let body;
      if (daysUntil < 0) body = `${med.name}${med.dose ? " (" + med.dose + ")" : ""} refill is overdue!${med.refills_remaining != null ? " " + med.refills_remaining + " refills remaining." : ""}`;
      else if (daysUntil === 0) body = `${med.name}${med.dose ? " (" + med.dose + ")" : ""} needs to be refilled today.${med.refills_remaining != null ? " " + med.refills_remaining + " refills remaining." : ""}`;
      else body = `${med.name}${med.dose ? " (" + med.dose + ")" : ""} refill due in ${daysUntil} days.${med.refills_remaining != null ? " " + med.refills_remaining + " refills remaining." : ""}`;

      // Log activity
      await supabase.from("activity").insert({
        senior_id: med.senior_id, type: "refill_reminder",
        description: `Prescription refill reminder: ${body}`,
        timestamp: new Date().toISOString(),
      });

      // Create alert for family dashboard
      await supabase.from("alerts").insert({
        senior_id: med.senior_id, type: "refill",
        message: body, resolved: false,
      });

      // Send push notification
      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, subscription_json")
        .eq("senior_id", med.senior_id);

      for (const sub of (subs || [])) {
        try {
          await webpush.sendNotification(
            JSON.parse(sub.subscription_json),
            JSON.stringify({
              title: "💊 Prescription Refill Reminder",
              body, icon: "/icons/icon-192.png",
              badge: "/icons/badge-72.png", tag,
            })
          );
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }
    }
  } catch (e) {
    console.error("[RefillReminder] Error:", e.message);
  }
}

// ── Appointment reminder push notifications ──────────────────────────────────
// Sends a reminder 1 hour before and 15 minutes before each appointment
async function checkAppointmentReminders() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL === "YOUR_SUPABASE_PROJECT_URL") return;

  try {
    const now = new Date();

    // Get upcoming appointments with a time set, joined with senior timezone
    // Check both today and tomorrow (UTC) to cover timezone edge cases
    const utcToday = now.toISOString().split("T")[0];
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const utcTomorrow = tomorrow.toISOString().split("T")[0];
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const utcYesterday = yesterday.toISOString().split("T")[0];

    const { data: appts } = await supabase
      .from("appointments")
      .select("id, title, date, time, location, senior_id, seniors!inner(timezone)")
      .in("date", [utcYesterday, utcToday, utcTomorrow])
      .not("time", "is", null);

    if (!appts || !appts.length) return;

    for (const appt of appts) {
      const tz = appt.seniors?.timezone || "America/New_York";

      // Check if this appointment is actually today in the user's timezone
      const localToday = now.toLocaleDateString("en-CA", { timeZone: tz });
      if (appt.date !== localToday) continue;

      // Parse appointment time (e.g. "2:00 PM" -> hours/minutes)
      const timeMatch = (appt.time || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!timeMatch) continue;
      let apptHour = parseInt(timeMatch[1]);
      const apptMin = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();
      if (period === "PM" && apptHour < 12) apptHour += 12;
      if (period === "AM" && apptHour === 12) apptHour = 0;

      // Build the appointment time in the user's timezone, then compare with "now"
      // Get the current local time components in user's tz
      const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
      const apptTimeLocal = new Date(localNow);
      apptTimeLocal.setHours(apptHour, apptMin, 0, 0);
      const diffMin = Math.round((apptTimeLocal - localNow) / 60000);

      // Send at ~60 min before and ~15 min before (within 1-minute cron window)
      const shouldNotify = (diffMin >= 59 && diffMin <= 61) || (diffMin >= 14 && diffMin <= 16);
      if (!shouldNotify) continue;

      const label = diffMin > 30 ? "in about 1 hour" : "in 15 minutes";
      const locationStr = appt.location ? ` at ${appt.location}` : "";

      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, subscription_json")
        .eq("senior_id", appt.senior_id);

      for (const sub of (subs || [])) {
        try {
          await webpush.sendNotification(
            JSON.parse(sub.subscription_json),
            JSON.stringify({
              title: `📅 ${appt.title} — ${label}`,
              body: `Your appointment is ${label}${locationStr}`,
              icon: "/icons/icon-192.png",
              badge: "/icons/badge-72.png",
              tag: `appt-${appt.id}-${diffMin > 30 ? "60" : "15"}-${localToday}`,
            })
          );
          await supabase.from("push_subscriptions")
            .update({ last_used: new Date().toISOString() })
            .eq("id", sub.id);
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }
    }
  } catch (e) {
    console.error("[ApptReminder] Check error:", e.message);
  }
}

// ── Due reminder/to-do push notifications ────────────────────────────────────
// Sends a notification when a reminder's due_date + due_time arrives
async function checkDueReminders() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL === "YOUR_SUPABASE_PROJECT_URL") return;

  try {
    const now = new Date();
    // Fetch a wide date range to cover timezone edge cases, then filter locally
    const utcToday = now.toISOString().split("T")[0];
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);

    const { data: reminders } = await supabase
      .from("reminders")
      .select("id, text, due_date, due_time, senior_id, seniors!inner(timezone)")
      .eq("completed", false)
      .in("due_date", [yesterday.toISOString().split("T")[0], utcToday, tomorrow.toISOString().split("T")[0]]);

    if (!reminders || !reminders.length) return;

    for (const rem of reminders) {
      const tz = rem.seniors?.timezone || "America/New_York";

      // Check if this reminder is due today in the user's timezone
      let localToday, localTime;
      try {
        localToday = now.toLocaleDateString("en-CA", { timeZone: tz });
        localTime = now.toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
        });
      } catch {
        localToday = utcToday;
        localTime = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      }

      if (rem.due_date !== localToday) continue;

      // If reminder has a due_time, only notify at that time
      // If no due_time, notify once at 9:00 AM
      const targetTime = rem.due_time || "9:00 AM";
      if (targetTime !== localTime) continue;

      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("id, subscription_json")
        .eq("senior_id", rem.senior_id);

      for (const sub of (subs || [])) {
        try {
          await webpush.sendNotification(
            JSON.parse(sub.subscription_json),
            JSON.stringify({
              title: "🔔 Reminder",
              body: rem.text,
              icon: "/icons/icon-192.png",
              badge: "/icons/badge-72.png",
              tag: `rem-${rem.id}-${localToday}`,
            })
          );
          await supabase.from("push_subscriptions")
            .update({ last_used: new Date().toISOString() })
            .eq("id", sub.id);
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }
    }
  } catch (e) {
    console.error("[DueReminder] Check error:", e.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Stripe webhooks need raw body — must be before express.json()
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) {
    console.error("[Stripe] Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const seniorId = session.metadata?.seniorId;
        if (seniorId) {
          // Check if subscription is in trial
          const sub = session.subscription ? await stripe.subscriptions.retrieve(session.subscription) : null;
          const isTrial = sub?.status === "trialing";
          await supabase.from("seniors").update({
            stripe_customer_id: session.customer,
            subscription_status: isTrial ? "trialing" : "active",
            subscription_plan: session.metadata?.plan || "premium",
            trial_ends_at: isTrial && sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          }).eq("id", seniorId);
          console.log(`[Stripe] ✅ Subscription ${isTrial ? "trial started" : "activated"} for ${seniorId}`);
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const { data: senior } = await supabase.from("seniors").select("id")
          .eq("stripe_customer_id", sub.customer).single();
        if (senior) {
          const status = sub.status === "trialing" ? "trialing" : sub.status === "active" ? "active" : sub.status;
          const updates = { subscription_status: status };
          if (sub.trial_end) updates.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
          await supabase.from("seniors").update(updates).eq("id", senior.id);
          console.log(`[Stripe] Subscription updated: ${status} for ${senior.id}`);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const { data: senior } = await supabase.from("seniors").select("id, name, email")
          .eq("stripe_customer_id", sub.customer).single();
        if (senior) {
          await supabase.from("seniors").update({ subscription_status: "cancelled" }).eq("id", senior.id);
          // Admin notification for cancellation
          await supabase.from("alerts").insert({
            senior_id: senior.id, type: "cancellation",
            message: `Subscription cancelled: ${senior.name || "Unknown"} (${senior.email || senior.id})`,
            severity: "warning", resolved: false,
          }).catch(() => {});
          console.log(`[Stripe] Subscription cancelled for ${senior.id}`);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const { data: senior } = await supabase.from("seniors").select("id, email")
          .eq("stripe_customer_id", invoice.customer).single();
        if (senior) {
          await supabase.from("seniors").update({ subscription_status: "past_due" }).eq("id", senior.id);
          console.log(`[Stripe] Payment failed for ${senior.id}`);
        }
        break;
      }
    }
  } catch (e) {
    console.error("[Stripe] Webhook handler error:", e.message);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "1mb" }));

// Trust proxy (Railway, Heroku, etc.) — needed for correct req.ip in rate limiting
app.set("trust proxy", 1);

// ── Request logger (debug) ──────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

// ── Rate Limiting (in-memory, no dependencies) ──────────────────────────────
const rateLimitMap = new Map();
const RATE_WINDOW = 60 * 1000; // 1 minute window
const RATE_LIMITS = {
  login: { max: 5, window: RATE_WINDOW },       // 5 login attempts per minute
  api: { max: 60, window: RATE_WINDOW },         // 60 API calls per minute
  upload: { max: 10, window: RATE_WINDOW * 5 },  // 10 uploads per 5 minutes
  chat: { max: 20, window: RATE_WINDOW },        // 20 chat messages per minute
  tts: { max: 30, window: RATE_WINDOW },         // 30 TTS requests per minute
};

function rateLimit(category = "api") {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    const key = `${category}:${ip}`;
    const limit = RATE_LIMITS[category] || RATE_LIMITS.api;
    const now = Date.now();

    let bucket = rateLimitMap.get(key);
    if (!bucket || now - bucket.start > limit.window) {
      bucket = { count: 0, start: now };
      rateLimitMap.set(key, bucket);
    }

    bucket.count++;
    if (bucket.count > limit.max) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    }
    next();
  };
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitMap) {
    if (now - bucket.start > RATE_LIMITS.api.window * 2) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

// ── Input Sanitization ──────────────────────────────────────────────────────
function sanitize(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/[<>]/g, "")           // strip HTML angle brackets
    .replace(/javascript:/gi, "")    // strip JS protocol
    .replace(/on\w+\s*=/gi, "")      // strip inline event handlers
    .trim()
    .slice(0, 10000);                // cap length
}

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string") {
        req.body[key] = sanitize(req.body[key]);
      }
    }
  }
  next();
}

// Security headers + CORS
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://js.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://images.pexels.com https://images.unsplash.com; connect-src 'self' https://api.stripe.com https://nominatim.openstreetmap.org; frame-src https://js.stripe.com;");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self)");
  // CORS — lock to production domain (set FRONTEND_URL in env)
  const origin = req.headers.origin;
  const allowed = process.env.FRONTEND_URL || "";
  if (IS_PROD) {
    // In production, only allow the explicitly configured origin
    if (origin && allowed && origin === allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  } else {
    // In dev, allow any origin for convenience
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-senior-token,x-family-token,x-admin-token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(sanitizeBody);

// Serve sw.js with no-cache so browsers always check for updates
app.get("/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

app.use(express.static(path.join(__dirname, "public")));

// ── Seed demo data on first run ───────────────────────────────────────────────
async function seedIfEmpty() {
  const { data } = await supabase.from("seniors").select("id").limit(1);
  if (data && data.length > 0) return;
  console.log("📦 First run — demo data is seeded via supabase-schema.sql");
}

// ─────────────────────────────────────────────────────────────────────────────
// SENIOR
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/senior/:id", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    const { data, error } = await supabase.from("seniors").select("*")
      .eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "Senior not found" });
    res.json(safeSenior(norm(data)));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ── Phone Numbers ─────────────────────────────────────────────────────────────
// GET phone numbers for a senior (accessible by both senior and family)
app.get("/api/phones/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data } = await supabase.from("seniors")
      .select("senior_phone, family_phone")
      .eq("id", req.params.seniorId).single();
    if (!data) return res.status(404).json({ error: "Senior not found" });
    res.json({ seniorPhone: data.senior_phone || "", familyPhone: data.family_phone || "" });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// PUT update phone numbers (accessible by both senior and family)
app.put("/api/phones/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { seniorPhone, familyPhone } = req.body;
    const updates = {};
    if (seniorPhone !== undefined) updates.senior_phone = seniorPhone.replace(/[^\d+\-()\s]/g, "").trim();
    if (familyPhone !== undefined) updates.family_phone = familyPhone.replace(/[^\d+\-()\s]/g, "").trim();
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No phone fields provided" });
    await supabase.from("seniors").update(updates).eq("id", req.params.seniorId);
    res.json({ success: true, ...updates });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDICATIONS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/medications/:seniorId", seniorAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data: meds } = await supabase.from("medications").select("*")
      .eq("senior_id", req.params.seniorId).eq("active", true);

    // Use user's timezone to determine "today" (server runs in UTC)
    const tz = req.query.tz || req.query.timezone;
    let todayStart;
    if (tz) {
      try {
        const nowInTz = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // "YYYY-MM-DD"
        todayStart = new Date(`${nowInTz}T00:00:00`);
        // Convert local midnight back to UTC for DB query
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, timeZoneName: "shortOffset" }).formatToParts(todayStart);
        // Simpler: calculate offset by comparing local midnight with UTC
        const localMidnightStr = `${nowInTz}T00:00:00`;
        const utcNow = new Date();
        const localNow = new Date(utcNow.toLocaleString("en-US", { timeZone: tz }));
        const offsetMs = localNow.getTime() - utcNow.getTime();
        todayStart = new Date(new Date(localMidnightStr).getTime() - offsetMs);
      } catch { todayStart = new Date(); todayStart.setHours(0, 0, 0, 0); }
    } else {
      todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    }
    const { data: logs } = await supabase.from("med_log").select("medication_id, dose_time")
      .eq("senior_id", req.params.seniorId)
      .gte("taken_at", todayStart.toISOString());

    // Build map: medId -> Set of dose_times taken today
    const takenMap = {};
    for (const l of (logs || [])) {
      if (!takenMap[l.medication_id]) takenMap[l.medication_id] = new Set();
      takenMap[l.medication_id].add(l.dose_time || "default");
    }

    res.json(normArr(meds).map(m => {
      // Parse med_times (backward compat: fall back to single time field)
      let times;
      try { times = m.medTimes ? JSON.parse(m.medTimes) : null; } catch { times = null; }
      if (!times || !Array.isArray(times) || times.length === 0) {
        times = m.time ? [m.time] : ["8:00 AM"];
      }
      const takenSet = takenMap[m.id || m._id] || new Set();
      const dosesTotal = times.length;
      const dosesTaken = times.filter(t => takenSet.has(t)).length;
      // Per-dose status for UI
      const doses = times.map(t => ({ time: t, taken: takenSet.has(t) }));
      return {
        ...m, medTimes: times, frequency: m.frequency || times.length,
        doses, dosesTaken, dosesTotal,
        takenToday: dosesTaken >= dosesTotal,
      };
    }));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/medications/:id/taken", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    const { doseTime } = req.body || {};
    const { data: med } = await supabase.from("medications").select("*")
      .eq("id", req.params.id).single();
    if (!med) return res.status(404).json({ error: "Medication not found" });

    await supabase.from("med_log").insert({
      senior_id: med.senior_id, medication_id: med.id,
      medication_name: med.name, dose_time: doseTime || med.time || null,
      taken_at: new Date().toISOString(),
    });
    await supabase.from("activity").insert({
      senior_id: med.senior_id, type: "medication_taken",
      description: `Took ${med.name} ${med.dose || ""}${doseTime ? " (" + doseTime + " dose)" : ""}`,
      timestamp: new Date().toISOString(),
    });
    await trackUsage(med.senior_id, "medications_taken");
    res.json({ success: true, message: `${med.name} marked as taken` });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/medications/:id/untake", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    const { doseTime } = req.body || {};
    const { data: med } = await supabase.from("medications").select("*")
      .eq("id", req.params.id).single();
    if (!med) return res.status(404).json({ error: "Medication not found" });

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    // Delete the most recent log entry for this med+dose today
    const { data: logs } = await supabase.from("med_log")
      .select("id").eq("medication_id", med.id).eq("dose_time", doseTime || med.time || null)
      .gte("taken_at", todayStart.toISOString())
      .order("taken_at", { ascending: false }).limit(1);
    if (logs && logs.length > 0) {
      await supabase.from("med_log").delete().eq("id", logs[0].id);
    }
    res.json({ success: true, message: `${med.name} unmarked` });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// GET /api/medications/scan/status — diagnostic check for scan pipeline (admin only)
app.get("/api/medications/scan/status", adminAuth, (req, res) => {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  res.json({
    configured: !!apiKey && apiKey.length > 10,
    scanModel: process.env.SCAN_MODEL || "claude-sonnet-4-5-20250929",
    maxFileSize: "15MB",
  });
});

// POST /api/medications/scan — Claude Vision reads a medication bottle label
app.post("/api/medications/scan", rateLimit("upload"), upload.single("image"), anyAuth, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image provided" });
    const b64  = req.file.buffer.toString("base64");
    const mime = req.file.mimetype;
    console.log(`[MedScan] Received image: ${(req.file.size / 1024).toFixed(1)}KB, ${mime}`);

    const scanModel = process.env.SCAN_MODEL || "claude-sonnet-4-5-20250929";
    const response = await anthropic.messages.create({
      model: scanModel,
      max_tokens: 600,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: `This is a photo of a prescription medication bottle or label.
Extract the medication information and return ONLY a valid JSON object — no explanation, no markdown, just JSON.
Fields:
- "name": medication name (string, required)
- "dose": dosage/strength like "10mg", "500mg" (string or null)
- "frequency": how many times per day — infer from directions. "once daily"=1, "twice daily"/"every 12 hours"=2, "three times daily"/"every 8 hours"=3 (number, default 1)
- "times": array of times to take — infer from frequency and directions. Examples: once daily morning → ["8:00 AM"], twice daily → ["8:00 AM","8:00 PM"], three times daily → ["8:00 AM","2:00 PM","9:00 PM"], at bedtime → ["9:00 PM"] (array of strings, required)
- "withFood": true if label says "take with food" or "take with meals" (boolean, default false)
- "directions": the full directions text as written (string or null)
- "prescriber": doctor name if visible on label (string or null)
- "refills": number of refills remaining as a number (number or null)
- "daysSupply": number of days the prescription supply lasts, e.g. "30 day supply" → 30, "QTY 90" with once daily → 90 (number or null)
- "lastFilled": the date the prescription was filled/dispensed if visible, in YYYY-MM-DD format (string or null)` }
      ]}],
    });

    const rawText = response.content[0].text;
    console.log(`[MedScan] Claude response: ${rawText.substring(0, 200)}`);
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return res.status(400).json({ error: "Could not read label — try a clearer photo" });
    const parsed = JSON.parse(match[0]);
    console.log(`[MedScan] Parsed medication: ${parsed.name}`);
    res.json(parsed);
  } catch (e) {
    console.error("[MedScan] Error:", e.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// POST /api/medications — add medication (family or scan)
app.post("/api/medications", anyAuth, rateLimit("api"), async (req, res) => {
  try {
    const { seniorId, name, dose, time, withFood, medTimes, frequency, refills, daysSupply, lastFilled, prescriber } = req.body;
    if (!seniorId || !name) return res.status(400).json({ error: "seniorId and name required" });

    // Build med_times array: prefer explicit medTimes, else wrap single time
    let timesArr = Array.isArray(medTimes) ? medTimes.filter(t => t && t.trim()) : [];
    if (timesArr.length === 0 && time) timesArr = [time];
    if (timesArr.length === 0) timesArr = ["8:00 AM"];
    const freq = frequency || timesArr.length || 1;

    // Compute next_refill from last_filled + days_supply
    let nextRefill = null;
    if (lastFilled && daysSupply) {
      const d = new Date(lastFilled);
      d.setDate(d.getDate() + parseInt(daysSupply));
      nextRefill = d.toISOString().split("T")[0];
    }

    const { data: med } = await supabase.from("medications").insert({
      senior_id: seniorId, name, dose: dose || null,
      time: timesArr[0], med_times: JSON.stringify(timesArr),
      frequency: freq, with_food: !!withFood, active: true,
      refills_remaining: refills != null ? parseInt(refills) : null,
      days_supply: daysSupply ? parseInt(daysSupply) : null,
      last_filled: lastFilled || null,
      next_refill: nextRefill,
      prescriber: prescriber || null,
    }).select().single();

    await supabase.from("activity").insert({
      senior_id: seniorId, type: "medication_added",
      description: `Medication added: ${name}${dose ? " " + dose : ""} (${freq}x daily)`,
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true, medication: norm(med) });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.put("/api/medications/:id", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    const { name, dose, medTimes, frequency, withFood, refills, daysSupply, lastFilled, prescriber } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Medication name is required" });
    let timesArr = Array.isArray(medTimes) ? medTimes.filter(t => t && t.trim()) : [];
    if (timesArr.length === 0) timesArr = ["8:00 AM"];
    const freq = frequency || timesArr.length || 1;

    let nextRefill = null;
    if (lastFilled && daysSupply) {
      const d = new Date(lastFilled);
      d.setDate(d.getDate() + parseInt(daysSupply));
      nextRefill = d.toISOString().split("T")[0];
    }

    await supabase.from("medications").update({
      name: name.trim(), dose: dose || null, time: timesArr[0],
      med_times: JSON.stringify(timesArr), frequency: freq,
      with_food: !!withFood,
      refills_remaining: refills != null ? parseInt(refills) : null,
      days_supply: daysSupply ? parseInt(daysSupply) : null,
      last_filled: lastFilled || null,
      next_refill: nextRefill,
      prescriber: prescriber || null,
    }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.delete("/api/medications/:id", anyAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("medications").update({ active: false }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/emergency", seniorAuth, async (req, res) => {
  try {
    const { seniorId, message } = req.body;
    const { data: alert } = await supabase.from("alerts").insert({
      senior_id: seniorId, type: "emergency",
      message: message || "Emergency button activated",
      severity: "critical", resolved: false,
    }).select().single();

    await supabase.from("activity").insert({
      senior_id: seniorId, type: "emergency",
      description: "Emergency button activated", timestamp: new Date().toISOString(),
    });
    await trackUsage(seniorId, "emergency_alerts");
    res.json({ success: true, alert: norm(alert) });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/chat", seniorAuth, suspendCheck, rateLimit("chat"), async (req, res) => {
  try {
    const { seniorId, message, sessionId, clientTime, timezone, location, includeTTS } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    const effectiveSeniorId = seniorId || DEMO_SENIOR_ID;

    // ── Parallel DB queries (saves ~300-500ms vs sequential) ──────────────────
    // Use client timezone for "today" boundaries (server runs in UTC)
    let todayStart;
    if (timezone) {
      try {
        const nowInTz = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
        const localMidnightStr = `${nowInTz}T00:00:00`;
        const utcNow = new Date();
        const localNow = new Date(utcNow.toLocaleString("en-US", { timeZone: timezone }));
        const offsetMs = localNow.getTime() - utcNow.getTime();
        todayStart = new Date(new Date(localMidnightStr).getTime() - offsetMs);
      } catch { todayStart = new Date(); todayStart.setHours(0, 0, 0, 0); }
    } else {
      todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    }
    const todayStr = timezone
      ? new Date().toLocaleDateString("en-CA", { timeZone: timezone })
      : todayStart.toISOString().slice(0, 10);
    const tomorrowStr = new Date(todayStart.getTime() + 86400000).toISOString().slice(0, 10);
    const twoWeeksStr = new Date(todayStart.getTime() + 14 * 86400000).toISOString().slice(0, 10);
    const [seniorRes, medsRes, logsRes, historyRes, todayApptsRes, upcomingApptsRes, remindersRes, memorySummary] = await Promise.all([
      supabase.from("seniors").select("*").eq("id", effectiveSeniorId).single(),
      supabase.from("medications").select("*").eq("senior_id", effectiveSeniorId).eq("active", true),
      supabase.from("med_log").select("medication_id, dose_time").eq("senior_id", effectiveSeniorId).gte("taken_at", todayStart.toISOString()).then(r => r.error ? { data: [] } : r),
      supabase.from("conversations").select("role, content").eq("senior_id", effectiveSeniorId).order("timestamp", { ascending: false }).limit(20),
      supabase.from("appointments").select("title, date, time, location, notes").eq("senior_id", effectiveSeniorId).gte("date", todayStr).lte("date", tomorrowStr).order("date").order("time"),
      supabase.from("appointments").select("title, date, time, location, notes").eq("senior_id", effectiveSeniorId).gt("date", tomorrowStr).lte("date", twoWeeksStr).order("date").order("time").limit(10),
      supabase.from("reminders").select("text, due_date, due_time").eq("senior_id", effectiveSeniorId).eq("completed", false).order("created_at"),
      getRelevantMemories(effectiveSeniorId),
    ]);
    const senior = seniorRes.data;
    const seniorName = senior?.name || "Friend";
    const conditions = (senior?.conditions || []).join(", ");

    // Persist user timezone and location for future sessions (non-blocking)
    if (timezone && senior && timezone !== senior.timezone) {
      supabase.from("seniors").update({ timezone }).eq("id", effectiveSeniorId).then(({ error }) => { if (error) console.error("[Chat] timezone save:", error.message); }).catch(e => console.error("[Chat] timezone save failed:", e.message));
    }
    if (location && senior && location !== senior.location) {
      supabase.from("seniors").update({ location }).eq("id", effectiveSeniorId).then(({ error }) => { if (error) console.error("[Chat] location save:", error.message); }).catch(e => console.error("[Chat] location save failed:", e.message));
    }

    // Fall back to stored location if client didn't send one (e.g. geolocation not yet resolved)
    const effectiveLocation = location || senior?.location || null;

    const meds = medsRes.data;
    // Parse current hour from clientTime (e.g. "02:30 PM" -> 14) to determine which dose is relevant
    let currentHour = new Date().getHours();
    if (clientTime) {
      try {
        const match = clientTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (match) {
          let h = parseInt(match[1]);
          const period = match[3].toUpperCase();
          if (period === "PM" && h < 12) h += 12;
          if (period === "AM" && h === 12) h = 0;
          currentHour = h;
        }
      } catch {}
    }
    function parseTimeHour(t) {
      const m = (t || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) return 8;
      let h = parseInt(m[1]);
      if (m[3].toUpperCase() === "PM" && h < 12) h += 12;
      if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
      return h;
    }
    const medSummary = (meds || []).map(m => {
      let times;
      try { times = m.med_times ? JSON.parse(m.med_times) : null; } catch { times = null; }
      if (!times || !Array.isArray(times) || times.length === 0) times = m.time ? [m.time] : [];
      const takenTimes = (logsRes.data || []).filter(l => l.medication_id === m.id).map(l => l.dose_time);
      const takenSet = new Set(takenTimes);
      // Only show doses that are due (within 2 hours past or any time future)
      const doseStatus = times.map(t => {
        const doseHour = parseTimeHour(t);
        const isPast = doseHour < currentHour - 2; // more than 2 hours ago
        const taken = takenSet.has(t);
        if (taken) return `${t}: taken`;
        if (isPast) return `${t}: MISSED`;
        return `${t}: NOT YET TAKEN`;
      }).join(", ");
      return `- ${m.name} ${m.dose || ""}${m.with_food ? " (with food)" : ""} [${times.length}x daily]: ${doseStatus}`;
    }).join("\n");
    const recentHistory = (historyRes.data || []).reverse();

    // Build today's schedule context
    const todayAppts = todayApptsRes.data || [];
    const upcomingAppts = upcomingApptsRes.data || [];
    const activeReminders = remindersRes.data || [];
    let scheduleSummary = "";
    if (todayAppts.length > 0) {
      const apptLines = todayAppts.map(a => {
        let line = `- ${a.title}`;
        if (a.date === todayStr) line += " (today)";
        else line += " (tomorrow)";
        if (a.time) line += ` at ${a.time}`;
        if (a.location) line += ` at ${a.location}`;
        if (a.notes) { const n = a.notes.length > 80 ? a.notes.substring(0, 77) + "…" : a.notes; line += ` — ${n}`; }
        return line;
      });
      scheduleSummary += "Today's and tomorrow's appointments:\n" + apptLines.join("\n");
    }
    if (upcomingAppts.length > 0) {
      const upLines = upcomingAppts.map(a => {
        let line = `- ${a.title} on ${a.date}`;
        if (a.time) line += ` at ${a.time}`;
        if (a.location) line += ` at ${a.location}`;
        return line;
      });
      if (scheduleSummary) scheduleSummary += "\n";
      scheduleSummary += "Upcoming appointments (next 2 weeks):\n" + upLines.join("\n");
    }
    if (activeReminders.length > 0) {
      const remLines = activeReminders.slice(0, 10).map(r => {
        let line = `- ${r.text}`;
        if (r.due_date) line += ` (due ${r.due_date}${r.due_time ? " at " + r.due_time : ""})`;
        return line;
      });
      if (scheduleSummary) scheduleSummary += "\n";
      scheduleSummary += "Active reminders/to-do:\n" + remLines.join("\n");
    }

    // Fetch weather if location provided and message is weather-related OR it's the first message (daily check-in)
    let weatherInfo = null;
    const isFirstMessage = recentHistory.length === 0;
    const weatherKeywords = /weather|temperature|outside|warm|cold|rain|sunny|snow|hot|humid|chill|wind|storm|degrees|forecast|jacket|coat|umbrella|dress.*(for|today|tomorrow)|what.*like out|how.*out(side)?|should i bring|do i need a/i;
    if (effectiveLocation && (weatherKeywords.test(message) || isFirstMessage)) {
      try {
        weatherInfo = await new Promise((resolve) => {

          const city  = encodeURIComponent(effectiveLocation);
          https.get(`https://wttr.in/${city}?format=%C+%t+%h+%w`, (r) => {
            let data = "";
            r.on("data", d => data += d);
            r.on("end", () => resolve(data.trim()));
          }).on("error", () => resolve(null));
        });
      } catch { weatherInfo = null; }
    }

    const messages = [
      ...recentHistory.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const systemPrompt = `You are Sage, a warm, caring, and supportive AI companion for ${seniorName}, a ${senior?.age || ""} year-old.

CRITICAL — VOICE RESPONSE FORMAT:
Your responses are read aloud by a voice assistant. Follow these rules strictly:
- NEVER use emojis of any kind — they will be read as "smiley face", "checkmark", etc.
- NEVER use bullet points, dashes, or lists — speak in natural flowing sentences only
- NEVER use markdown formatting (no asterisks, pound signs, brackets)
- Write exactly as you would speak to a kind, caring friend — warm, conversational, natural
- Keep responses to 2 to 4 sentences maximum

Your personality:
- Always kind, patient, gentle, and encouraging
- Speak simply and clearly — short sentences, no jargon
- Be a warm friend and companion, not a clinical assistant
- Use natural speech patterns — contractions are good ("I'm", "you're", "that's")

IMPORTANT — What you MUST NOT do:
- Never provide medical advice, diagnoses, or treatment recommendations
- Never comment on whether a medication dose is correct or safe
- Never provide legal or financial advice

YOUR CAPABILITIES — Be honest about what you can and cannot do:
You CAN: have friendly conversations, add appointments and reminders, track medications, provide general knowledge from your training, check the current weather, and offer encouragement.
You CANNOT: make phone calls, send texts or emails, look up real-time business info (hours, phone numbers, addresses), book appointments, access maps, or take any action outside this chat. NEVER offer to do these things.
Instead of saying "I can help you find that" or "Would you like me to call them," say something like "You might want to call your doctor's office directly" or "Your family member could help you look that up." Be helpful by suggesting what the USER can do, not by promising things YOU cannot do.

When ${seniorName} asks about symptoms, medications, medical concerns, or anything health-related:
1. Acknowledge their concern warmly
2. Gently explain: "I'm not able to give medical advice, but that's really a question for your doctor."
3. End your response with: [ASK_DOCTOR: <a clear question to ask their doctor>]

For true emergencies like chest pain, difficulty breathing, or a fall: Always say to call 911 or press the emergency button right away.

APPOINTMENTS & CALENDAR:
When ${seniorName} mentions an upcoming appointment, event, or anything that should go on a calendar (doctor visits, lunch plans, games, birthdays, errands, etc.):
1. Confirm what you heard back to them warmly, for example: "Got it, I've added your dentist appointment on Thursday at 2 PM to your calendar!"
2. CRITICAL: You MUST include this structured tag at the very END of your response — without it, nothing gets saved: [APPOINTMENT: {"title": "...", "date": "YYYY-MM-DD", "time": "2:00 PM" or null, "location": "..." or null, "notes": "..." or null}]
3. Use the current date/time context below to figure out the correct YYYY-MM-DD date. For example, if today is Monday Feb 27 and they say "this Thursday", that is March 2. "This Saturday" means the coming Saturday. "Next Saturday" means the Saturday of next week.
4. If they do NOT give enough info to determine a date (just "sometime" or "eventually"), ask them gently what day it is, do NOT output the tag.
5. The tag is machine-parsed and NEVER read aloud — the user only hears your friendly confirmation.
6. NEVER say you added something to the calendar without including the [APPOINTMENT: ...] tag. If you say it, you must tag it.

REMINDERS & TO-DO:
When ${seniorName} asks you to remind them of something, add something to their list, or mentions a task they need to do (pick up dry cleaning, call the bank, buy milk, etc.):
1. Confirm warmly, for example: "Got it, I've added 'pick up prescription' to your reminders!"
2. At the very END of your response, add: [REMINDER: {"text": "...", "date": "YYYY-MM-DD" or null, "time": "2:00 PM" or null}]
3. If they mention a date or day (like "tomorrow" or "next Friday"), include the date. If no date mentioned, set date to null.
4. You can output BOTH an APPOINTMENT tag and a REMINDER tag in the same response if appropriate.
5. The tag is machine-parsed and NEVER read aloud.

Today's medication status (doses marked MISSED are past due, NOT YET TAKEN are upcoming or current):
${medSummary || "No medications scheduled today"}
IMPORTANT: Only ask about doses that are "NOT YET TAKEN" or "MISSED" — never ask about doses that are not due yet. For multi-dose medications, only mention the current or next upcoming dose, not future doses that are hours away.

${scheduleSummary ? `SCHEDULE & REMINDERS:\n${scheduleSummary}` : "No appointments or reminders scheduled."}

DAILY CHECK-IN INSTRUCTIONS — READ CAREFULLY:
The conversation so far has ${recentHistory.length} prior messages.

${recentHistory.length === 0 ? `This is the FIRST message — ${seniorName} just opened the app. Greet them warmly and include a brief daily check-in. Mention the most important or time-sensitive appointments today if any exist above. Then, if any medications show "NOT YET TAKEN" and the current time is past that dose time, gently ask if they've had a chance to take them. Keep the whole check-in to 2 to 3 natural sentences after your greeting. For example: "Good morning! Just a heads up — you have a dentist appointment at 2 PM today. And it looks like you haven't taken your Metformin yet, have you had a chance to take it?" If everything is taken and there are no appointments, just give a warm encouraging greeting.` : ""}

${recentHistory.length >= 2 ? `You've ALREADY given the daily check-in in your first message. Do NOT repeat the daily rundown or medication reminders. PRIORITY: Just answer ${seniorName}'s question or respond naturally to what they said. Keep it focused on what they asked.` : ""}

LOCAL & LOCATION-AWARE HELP:
${effectiveLocation ? `${seniorName} lives in ${effectiveLocation}. When they ask about local places (pharmacies, doctors, restaurants, stores, hospitals, churches, libraries, etc.), give helpful answers using your general knowledge of that area. Mention well-known chains or landmarks nearby when you can. Important: You are using general knowledge, NOT real-time data. Always say something like "I believe there's a Walgreens near you, but you might want to call ahead to check hours" rather than stating hours or addresses as facts.` : `Location is not available. If they ask about local places, ask them what city they live in so you can help better next time.`}
WEATHER: You DO have access to real-time weather data. When "Current weather" appears below, use it to answer weather questions naturally — for example "It's a nice warm day out there, around 75 degrees" rather than raw numbers. If no weather data appears below, tell them you need their location to check the weather.

Current time: ${clientTime || new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
Today: ${timezone ? new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: timezone }) : new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
IMPORTANT: Only reference appointments that are TODAY or in the FUTURE. Never mention appointments whose date and time have already passed.
${effectiveLocation ? `User's location: ${effectiveLocation}` : ""}
${weatherInfo ? `Current weather: ${weatherInfo}` : ""}

WHAT YOU KNOW ABOUT ${seniorName.toUpperCase()}:
${memorySummary || `You're still getting to know ${seniorName}. Build memories naturally through conversation.`}

Use these memories naturally — reference them when relevant to show you remember and care about ${seniorName}.
Never invent facts not listed above. If something contradicts a memory, ask gently to clarify.`;

    // Haiku is 10-20x faster than Opus — ideal for conversational voice responses
    const chatModel = process.env.CHAT_MODEL || "claude-haiku-4-5-20251001";
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: chatModel,
          max_tokens: 500,
          system: systemPrompt,
          messages,
        });
        break; // success
      } catch (apiErr) {
        const status = apiErr?.status || apiErr?.statusCode || 0;
        console.error(`[Chat] API attempt ${attempt + 1} failed: ${status} ${apiErr.message}`);
        if (status === 529 && attempt < 2) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); // wait 1.5s, 3s
          continue;
        }
        throw apiErr; // re-throw on final attempt or non-retryable error
      }
    }

    const rawReply = response.content[0].text;

    // ── Track token usage for cost calculation (non-blocking) ────────────────
    const chatTokens = response.usage || {};

    // ── Clean reply and extract tags immediately ──────────────────────────────
    const askDoctorMatch = rawReply.match(/\[ASK_DOCTOR:\s*(.+?)\]/s);
    const suggestedQuestion = askDoctorMatch ? askDoctorMatch[1].trim() : null;
    const appointmentMatch = rawReply.match(/\[APPOINTMENT:\s*(\{[\s\S]*?\})\]/);
    const reminderMatch = rawReply.match(/\[REMINDER:\s*(\{[\s\S]*?\})\]/);

    const aiReply = rawReply
      .replace(/\[ASK_DOCTOR:\s*.+?\]/s, "")
      .replace(/\[APPOINTMENT:\s*\{[\s\S]*?\}\]/, "")
      .replace(/\[REMINDER:\s*\{[\s\S]*?\}\]/, "")
      .trim();

    const sid = sessionId || uuidv4();
    const spokenText = aiReply.replace(/[*#_~`>\[\](){}|]/g, "").replace(/\s+/g, " ").trim().slice(0, 4096);

    // ── Start TTS immediately (don't wait for anything else) ─────────────────
    const ttsApiKey = (process.env.OPENAI_API_KEY || "").trim();
    const ttsEnabled = includeTTS && ttsApiKey && !ttsApiKey.startsWith("YOUR_") && ttsApiKey.length >= 20;
    const ttsPromise = ttsEnabled ? new Promise((resolve) => {
      const ttsModel = (process.env.TTS_MODEL || "gpt-4o-mini-tts").trim();
      const voice = (process.env.TTS_VOICE || "coral").trim();
      const payload = JSON.stringify({
        model: ttsModel, input: spokenText, voice,
        ...(ttsModel === "gpt-4o-mini-tts" ? { instructions: "Speak in a warm, caring, gentle tone — like a kind friend checking in. Natural pace, not rushed. Calm and reassuring." } : {}),
        response_format: "mp3", speed: 1.05,
      });
      const ttsReq = https.request({
        hostname: "api.openai.com", path: "/v1/audio/speech", method: "POST",
        headers: { "Authorization": `Bearer ${ttsApiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (ttsRes) => {
        if (ttsRes.statusCode === 200) {
          const chunks = [];
          ttsRes.on("data", d => chunks.push(d));
          ttsRes.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
        } else { resolve(null); }
      });
      ttsReq.on("error", () => resolve(null));
      ttsReq.write(payload);
      ttsReq.end();
    }) : Promise.resolve(null);

    // ── Parse appointment/reminder tags and save — all non-blocking ──────────
    let savedAppointment = null;
    let savedReminder = null;

    const tagSaves = [];

    // Log when AI claims to add an appointment but doesn't include the tag
    if (!appointmentMatch && /added.*calendar|added.*appointment|put.*on.*calendar/i.test(aiReply)) {
      console.warn("[Chat] AI claimed to add appointment but no [APPOINTMENT:] tag found in raw reply:", rawReply.slice(-300));
    }

    if (appointmentMatch) {
      console.log("[Chat] APPOINTMENT tag found:", appointmentMatch[1]);
      tagSaves.push((async () => {
        try {
          const apptData = JSON.parse(appointmentMatch[1]);
          if (apptData.title && apptData.date) {
            const { data: appt } = await supabase.from("appointments").insert({
              senior_id: effectiveSeniorId, title: apptData.title, date: apptData.date,
              time: apptData.time || null, location: apptData.location || "", notes: apptData.notes || "",
              source: "voice", google_event_id: null,
            }).select().single();
            if (appt) {
              savedAppointment = { id: appt.id, title: apptData.title, date: apptData.date, time: apptData.time || null, location: apptData.location || null };
              supabase.from("activity").insert({ senior_id: effectiveSeniorId, type: "appointment_added", description: `Voice appointment: ${apptData.title} on ${apptData.date}`, timestamp: new Date().toISOString() }).then(() => {}).catch(e => console.error("[Chat] activity insert failed:", e.message));
              trackUsage(effectiveSeniorId, "appointments_added").catch(() => {});
            }
          }
        } catch (e) { console.error("[Chat] Appointment parse error:", e.message); }
      })());
    }

    if (reminderMatch) {
      tagSaves.push((async () => {
        try {
          const remData = JSON.parse(reminderMatch[1]);
          if (remData.text) {
            const { data: rem } = await supabase.from("reminders").insert({
              senior_id: effectiveSeniorId, text: remData.text,
              due_date: remData.date || null, due_time: remData.time || null,
              source: "voice", completed: false,
            }).select().single();
            if (rem) {
              savedReminder = { id: rem.id, text: remData.text, date: remData.date || null, time: remData.time || null };
              if (remData.date) {
                supabase.from("appointments").insert({ senior_id: effectiveSeniorId, title: remData.text, date: remData.date, time: remData.time || null, notes: "From reminders", source: "reminder" }).then(() => {}).catch(e => console.error("[Chat] reminder-to-appointment insert failed:", e.message));
              }
              supabase.from("activity").insert({ senior_id: effectiveSeniorId, type: "reminder_added", description: `Voice reminder: "${remData.text.slice(0, 60)}"`, timestamp: new Date().toISOString() }).then(() => {}).catch(e => console.error("[Chat] activity insert failed:", e.message));
            }
          }
        } catch (e) { console.error("[Chat] Reminder parse error:", e.message); }
      })());
    }

    // ── All in parallel: TTS + tag saves + conversation logging ──────────────
    const dbPromise = Promise.all([
      supabase.from("conversations").insert([
        { senior_id: effectiveSeniorId, session_id: sid, role: "user",      content: message,  timestamp: new Date().toISOString() },
        { senior_id: effectiveSeniorId, session_id: sid, role: "assistant", content: aiReply,  timestamp: new Date().toISOString() },
      ]),
      supabase.from("activity").insert({
        senior_id: effectiveSeniorId, type: "conversation",
        description: `Chat: "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`,
        timestamp: new Date().toISOString(),
      }),
      trackUsage(effectiveSeniorId, "chat_messages"),
      ...tagSaves,
    ]);

    const [ttsAudioBase64] = await Promise.all([ttsPromise, dbPromise]);

    const result = { reply: aiReply, sessionId: sid, suggestedQuestion, appointment: savedAppointment, reminder: savedReminder };
    if (ttsAudioBase64) result.audioBase64 = ttsAudioBase64;
    res.json(result);

    // Non-blocking: log cost + extract long-term memories
    const ttsChars = ttsEnabled ? spokenText.length : 0;
    logCost(effectiveSeniorId, "chat", chatModel, chatTokens.input_tokens, chatTokens.output_tokens, ttsChars).catch(() => {});
    extractMemories(effectiveSeniorId, message, aiReply)
      .then(() => console.log("[Memory] extraction completed for:", message.slice(0, 40)))
      .catch(e => console.error("[Memory] bg extract:", e.message));
  } catch (e) {
    console.error("[Chat] Error:", e.message, e.stack);
    const status = e?.status || e?.statusCode || 0;
    if (status === 529 || (e.message && e.message.includes("overloaded"))) {
      res.status(503).json({ error: "Sage is taking a quick breather — the AI service is busy right now. Please try again in a moment!", errorType: "overloaded" });
    } else if (status === 429) {
      res.status(429).json({ error: "Sage needs a moment to catch up. Please wait a few seconds and try again.", errorType: "rate_limit" });
    } else {
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEXT-TO-SPEECH (OpenAI TTS)
// ─────────────────────────────────────────────────────────────────────────────

// Quick status check — hit /api/tts/status to confirm TTS is configured
app.get("/api/tts/status", adminAuth, (req, res) => {
  const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
  const isPlaceholder = !openaiKey || openaiKey.startsWith("YOUR_") || openaiKey.length < 20;
  res.json({
    configured: !isPlaceholder,
    provider: "openai",
    voice: process.env.TTS_VOICE || "coral",
    issue: isPlaceholder ? "OPENAI_API_KEY is missing or still a placeholder" : null,
  });
});

// Live test endpoint — makes a real 1-word TTS call to verify the full pipeline (admin only)
app.get("/api/tts/test", adminAuth, async (req, res) => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("YOUR_") || apiKey.length < 20) {
    return res.json({ ok: false, error: "OPENAI_API_KEY not configured" });
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: "gpt-4o-mini-tts", input: "Hello there, how are you doing today?", voice: "coral", response_format: "mp3" });
      const ttsReq = https.request({
        hostname: "api.openai.com", path: "/v1/audio/speech", method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (ttsRes) => {
        let body = [];
        ttsRes.on("data", d => body.push(d));
        ttsRes.on("end", () => {
          const totalBytes = Buffer.concat(body).length;
          if (ttsRes.statusCode === 200) {
            resolve({ ok: true, status: 200, audioBytes: totalBytes, contentType: ttsRes.headers["content-type"] });
          } else {
            resolve({ ok: false, status: ttsRes.statusCode, error: Buffer.concat(body).toString().slice(0, 200) });
          }
        });
      });
      ttsReq.on("error", e => reject(e));
      ttsReq.write(payload);
      ttsReq.end();
    });
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: "TTS test failed" });
  }
});

app.post("/api/tts", seniorAuth, rateLimit("tts"), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("YOUR_") || apiKey.length < 20) {
    console.warn("[TTS] OPENAI_API_KEY not set or placeholder");
    return res.status(503).json({ error: "OpenAI TTS not configured — add OPENAI_API_KEY to Railway Variables" });
  }

  // gpt-4o-mini-tts voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse
  // coral = cheerful & warm, sage = calm & thoughtful — both great for elder care
  const voice = (process.env.TTS_VOICE || "coral").trim();
  const cleanText = text.slice(0, 4096); // OpenAI max is 4096 chars

  console.log(`[TTS] Request: voice=${voice}, text length=${cleanText.length}`);


  try {
    const audioStream = await new Promise((resolve, reject) => {
      const ttsModel = (process.env.TTS_MODEL || "gpt-4o-mini-tts").trim();
      const payload = JSON.stringify({
        model: ttsModel,
        input: cleanText,
        voice: voice,
        ...(ttsModel === "gpt-4o-mini-tts" ? {
          // gpt-4o-mini-tts supports natural language instructions for tone/style
          instructions: "Speak in a warm, caring, gentle tone — like a kind friend checking in. Natural pace, not rushed. Calm and reassuring.",
        } : {}),
        response_format: "mp3",
        speed: 1.05,
      });

      const options = {
        hostname: "api.openai.com",
        path: "/v1/audio/speech",
        method: "POST",
        headers: {
          "Authorization":  `Bearer ${apiKey}`,
          "Content-Type":   "application/json",
          "Content-Length":  Buffer.byteLength(payload),
        },
      };

      const ttsReq = https.request(options, (ttsRes) => {
        if (ttsRes.statusCode === 200) {
          resolve(ttsRes);
        } else {
          let errBody = "";
          ttsRes.on("data", d => errBody += d);
          ttsRes.on("end", () => {
            console.error(`[TTS] OpenAI error ${ttsRes.statusCode}: ${errBody.slice(0, 300)}`);
            reject(new Error(`OpenAI TTS ${ttsRes.statusCode}: ${errBody.slice(0, 150)}`));
          });
        }
      });

      ttsReq.on("error", reject);
      ttsReq.write(payload);
      ttsReq.end();
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");
    audioStream.pipe(res);
  } catch (e) {
    console.error("[TTS] Failed:", e.message);
    res.status(502).json({ error: "Voice synthesis failed. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEECH-TO-TEXT (Whisper) — fallback for browsers without SpeechRecognition
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/transcribe", rateLimit("api"), upload.single("audio"), seniorAuth, async (req, res) => {
  try {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey || apiKey.startsWith("YOUR_") || apiKey.length < 20) {
      return res.status(503).json({ error: "Transcription not configured" });
    }
    if (!req.file) return res.status(400).json({ error: "No audio file" });

    // Build multipart form for OpenAI Whisper API
    const boundary = "----WhisperBoundary" + Date.now();
    const ext = req.file.mimetype === "audio/webm" ? "webm" : req.file.mimetype === "audio/mp4" ? "m4a" : "wav";
    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${req.file.mimetype}\r\n\r\n`);
    parts.push(req.file.buffer);
    parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe`);
    parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen`);
    parts.push(`\r\n--${boundary}--\r\n`);

    const body = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));

      const whisperRes = await new Promise((resolve, reject) => {
      const wreq = https.request({
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      }, (wres) => {
        let data = "";
        wres.on("data", d => data += d);
        wres.on("end", () => {
          if (wres.statusCode === 200) resolve(JSON.parse(data));
          else reject(new Error(`Whisper ${wres.statusCode}: ${data.slice(0, 200)}`));
        });
      });
      wreq.on("error", reject);
      wreq.write(body);
      wreq.end();
    });

    res.json({ text: whisperRes.text || "" });
  } catch (e) {
    console.error("[Transcribe] Error:", e.message);
    res.status(502).json({ error: "Transcription failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DOCTOR QUESTIONS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/doctor-questions/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data } = await supabase.from("doctor_questions").select("*")
      .eq("senior_id", req.params.seniorId).order("created_at", { ascending: false });
    res.json(normArr(data));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/doctor-questions", seniorAuth, async (req, res) => {
  try {
    const { seniorId, question } = req.body;
    if (!seniorId || !question) return res.status(400).json({ error: "seniorId and question required" });
    const { data: q } = await supabase.from("doctor_questions").insert({
      senior_id: seniorId, question: question.trim(), asked: false,
    }).select().single();
    await supabase.from("activity").insert({
      senior_id: seniorId, type: "doctor_question",
      description: `Doctor question: "${question.slice(0, 60)}"`, timestamp: new Date().toISOString(),
    });
    await trackUsage(seniorId, "doctor_questions_added");
    res.json({ success: true, question: norm(q) });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.patch("/api/doctor-questions/:id/asked", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("doctor_questions")
      .update({ asked: true, asked_at: new Date().toISOString() }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.delete("/api/doctor-questions/:id", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("doctor_questions").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DOCTOR VISITS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/doctor-visits/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data } = await supabase.from("doctor_visits").select("*")
      .eq("senior_id", req.params.seniorId).order("created_at", { ascending: false });
    res.json(normArr(data));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/doctor-visits", seniorAuth, async (req, res) => {
  try {
    const { seniorId, transcript, doctorName, notes } = req.body;
    console.log(`[DoctorVisit] Save request — seniorId: ${seniorId}, tokenSeniorId: ${req.seniorId}, words: ${transcript ? transcript.trim().split(/\s+/).length : 0}, hasTranscript: ${!!transcript}`);
    if (!seniorId || !transcript) return res.status(400).json({ error: "seniorId and transcript required" });
    const { data: visit, error: insertErr } = await supabase.from("doctor_visits").insert({
      senior_id: seniorId, transcript: transcript.trim(),
      doctor_name: doctorName || "", notes: notes || "",
      word_count: transcript.trim().split(/\s+/).length,
    }).select().single();
    if (insertErr) {
      console.error("[DoctorVisit] Supabase insert error:", insertErr.message);
      return res.status(500).json({ error: insertErr.message });
    }
    await supabase.from("activity").insert({
      senior_id: seniorId, type: "doctor_visit",
      description: `Doctor visit recorded${doctorName ? " with Dr. " + doctorName : ""}`,
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true, visit: norm(visit) });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// FAMILY API
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/senior/by-code/:code", rateLimit("login"), async (req, res) => {
  try {
    const { data } = await supabase.from("seniors").select("id, name, family_code, age")
      .eq("family_code", req.params.code.toUpperCase()).single();
    if (!data) return res.status(404).json({ error: "Invalid family code" });
    res.json(norm(data));
  } catch (e) { res.status(500).json({ error: "Lookup failed" }); }
});

app.get("/api/dashboard/:seniorId", familyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { seniorId } = req.params;
    const { data: senior } = await supabase.from("seniors").select("*").eq("id", seniorId).single();
    if (!senior) return res.status(404).json({ error: "Senior not found" });

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [
      { data: meds },
      { data: logs },
      { data: alerts },
      { data: convos },
      { data: activity },
    ] = await Promise.all([
      supabase.from("medications").select("*").eq("senior_id", seniorId).eq("active", true),
      supabase.from("med_log").select("medication_id").eq("senior_id", seniorId).gte("taken_at", todayStart.toISOString()),
      supabase.from("alerts").select("*").eq("senior_id", seniorId).eq("resolved", false),
      supabase.from("conversations").select("id").eq("senior_id", seniorId).eq("role", "user").gte("timestamp", todayStart.toISOString()),
      supabase.from("activity").select("*").eq("senior_id", seniorId).order("timestamp", { ascending: false }).limit(20),
    ]);

    const takenToday = (logs || []).length;
    // Total expected doses = sum of each med's frequency (multi-dose meds count multiple times)
    const totalExpectedDoses = (meds || []).reduce((sum, m) => sum + (m.frequency || 1), 0);
    const adherence  = totalExpectedDoses > 0 ? Math.min(100, Math.round((takenToday / totalExpectedDoses) * 100)) : 0;

    res.json({
      senior: safeSenior(norm(senior)),
      stats: {
        medicationsTaken: takenToday,
        medicationsTotal: (meds || []).length,
        adherence,
        activeAlerts: (alerts || []).length,
        conversationsToday: (convos || []).length,
      },
      alerts: normArr(alerts),
      recentActivity: normArr(activity),
      medications: normArr(meds).map(m => ({ ...m, takenToday: (logs || []).some(l => l.medication_id === m.id) })),
    });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/alerts/:id/resolve", familyAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("alerts")
      .update({ resolved: true, resolved_at: new Date().toISOString() }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.get("/api/conversations/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data: rows } = await supabase.from("conversations").select("*")
      .eq("senior_id", req.params.seniorId).order("timestamp", { ascending: true }).limit(200);
    const sessions = {};
    for (const row of (rows || [])) {
      if (!sessions[row.session_id]) sessions[row.session_id] = [];
      sessions[row.session_id].push(toCamel(row));
    }
    const sessionList = Object.entries(sessions)
      .map(([id, msgs]) => ({ sessionId: id, messages: msgs, startedAt: msgs[0].timestamp }))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 20);
    res.json(sessionList);
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/appointments/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data } = await supabase.from("appointments").select("*")
      .eq("senior_id", req.params.seniorId).order("date", { ascending: true });
    res.json(normArr(data));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/appointments", seniorAuth, rateLimit("api"), async (req, res) => {
  try {
    const { seniorId, title, date, time, location, notes, source } = req.body;
    if (!seniorId || !title || !date) return res.status(400).json({ error: "seniorId, title, date required" });
    const { data: appt } = await supabase.from("appointments").insert({
      senior_id: seniorId, title, date, time: time || null,
      location: location || "", notes: notes || "",
      source: source || "manual", google_event_id: null,
    }).select().single();
    await supabase.from("activity").insert({
      senior_id: seniorId, type: "appointment_added",
      description: `Appointment: ${title} on ${date}`, timestamp: new Date().toISOString(),
    });
    await trackUsage(seniorId, "appointments_added");
    res.json({ success: true, appointment: norm(appt) });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.delete("/api/appointments/:id", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("appointments").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/appointments/parse", seniorAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 300,
      messages: [{ role: "user", content: `Today is ${today}. Parse this appointment into JSON. Return ONLY valid JSON.\n\nInput: "${text}"\n\nReturn: { "title": string, "date": "YYYY-MM-DD", "time": "2:00 PM or null", "location": string or null, "notes": string or null }` }],
    });
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(400).json({ error: "Could not parse appointment" });
    res.json(JSON.parse(match[0]));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/appointments/ocr", rateLimit("upload"), upload.single("image"), seniorAuth, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image provided" });
    const b64  = req.file.buffer.toString("base64");
    const mime = req.file.mimetype;
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929", max_tokens: 1500,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: `This is a photo of a paper calendar. Today's month/year: ${today}.\nExtract every appointment, event, or note.\nReturn ONLY a JSON array:\n[ { "title": "event name", "date": "YYYY-MM-DD", "time": "2:00 PM or null", "notes": "extra detail or null" } ]` }
      ]}],
    });
    const match = response.content[0].text.match(/\[[\s\S]*\]/);
    res.json({ events: match ? JSON.parse(match[0]) : [] });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.get("/api/calendar/:seniorId/feed.ics", validateUUID("seniorId"), async (req, res) => {
  try {
    const { seniorId } = req.params;
    // Verify access: accept senior/family token (header or query) or calendar feed token (query)
    const queryToken = req.query.token;
    const headerToken = req.headers["x-senior-token"] || req.headers["x-family-token"];
    const isValidSenior   = verifySeniorToken(headerToken || queryToken);
    const isValidFamily   = verifyFamilyToken(headerToken || queryToken);
    const isValidFeed     = verifyCalendarFeedToken(queryToken);
    if (!isValidSenior && !isValidFamily && !isValidFeed) {
      return res.status(401).json({ error: "Authentication required — pass token as query param or header" });
    }
    const { data: senior } = await supabase.from("seniors").select("name, timezone").eq("id", seniorId).single();
    const feedTz = senior?.timezone || "America/New_York";
    const { data: appts }  = await supabase.from("appointments").select("*").eq("senior_id", seniorId);

    // Parse time string like "2:00 PM", "14:00", "3:30 pm" into { hours, minutes }
    function parseTime(timeStr) {
      if (!timeStr) return { hours: 0, minutes: 0 };
      const t = timeStr.trim();
      // Try 12-hour format: "2:00 PM", "11:30 am"
      const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)$/i);
      if (m12) {
        let h = parseInt(m12[1], 10);
        const min = parseInt(m12[2], 10);
        const isPM = m12[3].toUpperCase() === "PM";
        if (isPM && h !== 12) h += 12;
        if (!isPM && h === 12) h = 0;
        return { hours: h, minutes: min };
      }
      // Try 24-hour format: "14:00", "9:30"
      const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
      if (m24) return { hours: parseInt(m24[1], 10), minutes: parseInt(m24[2], 10) };
      return { hours: 0, minutes: 0 };
    }

    // Format as iCal date-time: YYYYMMDDTHHMMSS (local, no Z — treated as floating time)
    function fmtLocal(dateStr, timeObj) {
      const d = dateStr.replace(/-/g, "");
      const h = String(timeObj.hours).padStart(2, "0");
      const m = String(timeObj.minutes).padStart(2, "0");
      return `${d}T${h}${m}00`;
    }

    const lines = (appts || []).map(a => {
      const time = parseTime(a.time);
      const startStr = fmtLocal(a.date, time);
      const endH = time.hours + 1;
      const endStr = fmtLocal(a.date, { hours: endH, minutes: time.minutes });
      return [
        "BEGIN:VEVENT",
        `UID:${a.id}@sage-companion`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
        `DTSTART:${startStr}`,
        `DTEND:${endStr}`,
        `SUMMARY:${(a.title || "").replace(/[\r\n]/g, " ")}`,
        a.location ? `LOCATION:${a.location.replace(/[\r\n]/g, " ")}` : null,
        a.notes ? `DESCRIPTION:${a.notes.replace(/[\r\n]/g, "\\n")}` : null,
        "END:VEVENT"
      ].filter(Boolean).join("\r\n");
    });

    const cal = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Sage Companion LLC//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:Sage Companion — ${senior?.name || "Calendar"}`,
      `X-WR-TIMEZONE:${feedTz}`,
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      ...lines,
      "END:VCALENDAR"
    ].join("\r\n");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sage-companion.ics"`);
    res.send(cal);
  } catch (e) { res.status(500).json({ error: "Calendar feed error" }); }
});

// GET /api/calendar/:seniorId/feed-token — returns a permanent feed token for webcal subscriptions
app.get("/api/calendar/:seniorId/feed-token", anyAuth, validateUUID("seniorId"), async (req, res) => {
  res.json({ token: makeCalendarFeedToken(req.params.seniorId) });
});

// ── Reminders / To-Do ─────────────────────────────────────────────────────────

app.get("/api/reminders/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data } = await supabase.from("reminders").select("*")
      .eq("senior_id", req.params.seniorId).order("created_at", { ascending: false });
    res.json(data || []);
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/reminders", seniorAuth, rateLimit("api"), async (req, res) => {
  try {
    const seniorId = req.body.seniorId || req.seniorId;
    const { text, dueDate, dueTime, source } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    const { data: reminder } = await supabase.from("reminders").insert({
      senior_id: seniorId, text, due_date: dueDate || null, due_time: dueTime || null,
      source: source || "manual", completed: false,
    }).select().single();
    // If there's a date, also create a calendar appointment
    let appointment = null;
    if (dueDate) {
      const { data: appt } = await supabase.from("appointments").insert({
        senior_id: seniorId, title: text, date: dueDate, time: dueTime || null,
        notes: "From reminders", source: "reminder", google_event_id: null,
      }).select().single();
      appointment = appt;
    }
    await supabase.from("activity").insert({
      senior_id: seniorId, type: "reminder_added",
      description: `Reminder: "${text.slice(0, 60)}"`,
      timestamp: new Date().toISOString(),
    });
    res.json({ reminder, appointment });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.patch("/api/reminders/:id/done", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("reminders").update({ completed: true }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.delete("/api/reminders/:id", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("reminders").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.delete("/api/reminders/:seniorId/clear-completed", seniorAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    await supabase.from("reminders").delete().eq("senior_id", req.params.seniorId).eq("completed", true);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ── Memory management endpoints ──────────────────────────────────────────────

// GET memories for a senior (family dashboard or admin)
app.get("/api/memories/:seniorId", seniorAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("memories")
      .select("id, category, memory_text, mention_count, last_mentioned, created_at")
      .eq("senior_id", req.params.seniorId)
      .order("category")
      .order("last_mentioned", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong." }); }
});

// DELETE a specific memory
app.delete("/api/memories/:id", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    await supabase.from("memories").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong." }); }
});

// DELETE all memories for a senior (reset)
app.delete("/api/memories/:seniorId/all", seniorAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    await supabase.from("memories").delete().eq("senior_id", req.params.seniorId);
    res.json({ success: true, message: "All memories cleared" });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong." }); }
});

// ── Google Calendar OAuth ─────────────────────────────────────────────────────
function getGoogleClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/google/callback"
  );
}

app.get("/api/google/auth", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send("Google Calendar not configured.");
  const client = getGoogleClient();
  const url = client.generateAuthUrl({
    access_type: "offline", prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: req.query.seniorId || DEMO_SENIOR_ID,
  });
  res.redirect(url);
});

app.get("/api/google/callback", async (req, res) => {
  try {
    const { code, state: seniorId } = req.query;
    const client = getGoogleClient();
    const { tokens } = await client.getToken(code);
    await supabase.from("seniors").update({ google_tokens: tokens }).eq("id", seniorId);
    res.redirect(`/calendar?google=connected&seniorId=${seniorId}`);
  } catch (e) { res.status(500).send("Google auth failed: " + e.message); }
});

app.get("/api/google/status/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { data } = await supabase.from("seniors").select("google_tokens").eq("id", req.params.seniorId).single();
    res.json({ connected: !!(data?.google_tokens), configured: !!process.env.GOOGLE_CLIENT_ID });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/google/sync/:seniorId", anyAuth, validateUUID("seniorId"), async (req, res) => {
  try {
    const { seniorId } = req.params;
    const userTz = req.body?.timezone || "America/New_York";
    console.log("[GoogleSync] timezone from client:", userTz);
    const { data: senior } = await supabase.from("seniors").select("*").eq("id", seniorId).single();
    if (!senior?.google_tokens) return res.status(401).json({ error: "Google not connected" });

    // Save timezone for future use (reminders, display, etc.)
    if (userTz && userTz !== senior.timezone) {
      await supabase.from("seniors").update({ timezone: userTz }).eq("id", seniorId);
    }

    const client = getGoogleClient();
    client.setCredentials(senior.google_tokens);
    client.on("tokens", async (tokens) => {
      await supabase.from("seniors").update({ google_tokens: { ...senior.google_tokens, ...tokens } }).eq("id", seniorId);
    });

    const cal = google.calendar({ version: "v3", auth: client });
    const now = new Date(), future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const gRes = await cal.events.list({
      calendarId: "primary", singleEvents: true, orderBy: "startTime",
      timeMin: now.toISOString(), timeMax: future.toISOString(), maxResults: 100,
      timeZone: userTz,
    });

    // Strip HTML tags and clean up Google Calendar descriptions to just core info
    function cleanDescription(desc) {
      if (!desc) return "";
      let text = desc.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      text = text.replace(/(Join with Google Meet|https?:\/\/meet\.google\.com\S*|https?:\/\/\S*zoom\.us\S*|Meeting ID:.*|Passcode:.*|Phone:.*\+\d[\d\s-]*)/gi, "");
      text = text.replace(/\s+/g, " ").trim();
      if (text.length > 120) text = text.substring(0, 117) + "…";
      return text;
    }

    // Convert Google dateTime to the user's local date/time using Intl.DateTimeFormat.formatToParts
    // This properly handles events created in other timezones (e.g. flights departing from EST)
    function getLocalParts(dateTimeStr, tz) {
      const d = new Date(dateTimeStr);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "numeric", minute: "2-digit", hour12: true,
      }).formatToParts(d);
      const get = (type) => (parts.find(p => p.type === type) || {}).value || "";
      return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), period: get("dayPeriod") };
    }

    function formatEventTime(dateTimeStr, tz) {
      try {
        const p = getLocalParts(dateTimeStr, tz);
        return `${p.hour}:${p.minute} ${p.period}`;
      } catch { return ""; }
    }

    function formatEventDate(dateTimeStr, tz) {
      try {
        const p = getLocalParts(dateTimeStr, tz);
        return `${p.year}-${p.month}-${p.day}`;
      } catch { return dateTimeStr.split("T")[0]; }
    }

    let pulled = 0;
    const items = gRes.data.items || [];
    if (items.length > 0) console.log("[GoogleSync] first event raw:", JSON.stringify({ summary: items[0].summary, start: items[0].start, end: items[0].end }));
    for (const ev of items) {
      if (!ev.summary) continue;
      const startRaw  = ev.start.dateTime || ev.start.date;
      // For timed events, format in user's timezone; for all-day events, use the date as-is
      const dateStr   = ev.start.dateTime ? formatEventDate(startRaw, userTz) : startRaw;
      const timeStr   = ev.start.dateTime ? formatEventTime(startRaw, userTz) : null;
      console.log("[GoogleSync] event:", ev.summary, "| raw:", startRaw, "| parsed date:", dateStr, "| parsed time:", timeStr);
      const cleanNotes = cleanDescription(ev.description);
      const { data: existing } = await supabase.from("appointments").select("id").eq("google_event_id", ev.id).eq("senior_id", seniorId).single();
      if (existing) {
        await supabase.from("appointments").update({ title: ev.summary, date: dateStr, time: timeStr, location: ev.location || "", notes: cleanNotes }).eq("id", existing.id);
      } else {
        await supabase.from("appointments").insert({ senior_id: seniorId, title: ev.summary, date: dateStr, time: timeStr, location: ev.location || "", notes: cleanNotes, source: "google", google_event_id: ev.id });
        pulled++;
      }
    }

    let pushed = 0;
    const { data: local } = await supabase.from("appointments").select("*").eq("senior_id", seniorId).is("google_event_id", null);
    for (const appt of (local || [])) {
      try {
        // Build start/end with user's timezone for proper Google Calendar placement
        if (appt.time) {
          const event = {
            summary: appt.title, location: appt.location || "", description: appt.notes || "",
            start: { dateTime: parseLocalDateTime(appt.date, appt.time, userTz), timeZone: userTz },
            end:   { dateTime: parseLocalDateTime(appt.date, appt.time, userTz, 60), timeZone: userTz },
          };
          const created = await cal.events.insert({ calendarId: "primary", resource: event });
          await supabase.from("appointments").update({ google_event_id: created.data.id }).eq("id", appt.id);
        } else {
          const event = {
            summary: appt.title, location: appt.location || "", description: appt.notes || "",
            start: { date: appt.date },
            end:   { date: appt.date },
          };
          const created = await cal.events.insert({ calendarId: "primary", resource: event });
          await supabase.from("appointments").update({ google_event_id: created.data.id }).eq("id", appt.id);
        }
        pushed++;
      } catch (e) { /* skip individual failures */ }
    }

    await supabase.from("activity").insert({
      senior_id: seniorId, type: "calendar_sync",
      description: `Google Calendar synced: ${pulled} pulled, ${pushed} pushed`,
      timestamp: new Date().toISOString(),
    });
    const { data: all } = await supabase.from("appointments").select("*").eq("senior_id", seniorId).order("date", { ascending: true });
    res.json({ success: true, pulled, pushed, appointments: normArr(all) });
  } catch (e) {
    console.error("[GoogleSync] Error:", e.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Helper: parse "2026-03-04" + "2:00 PM" + timezone into ISO string for Google Calendar
function parseLocalDateTime(dateStr, timeStr, tz, addMinutes) {
  try {
    // Parse the 12h time
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return `${dateStr}T09:00:00`;
    let h = parseInt(match[1]), m = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    if (addMinutes) {
      m += addMinutes;
      while (m >= 60) { h++; m -= 60; }
    }
    // Return as a local time string — Google Calendar uses the timeZone field to interpret it
    return `${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`;
  } catch {
    return `${dateStr}T09:00:00`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING — Create senior profile
// ─────────────────────────────────────────────────────────────────────────────

function generateFamilyCode() {
  // 6 random chars from 32-char alphabet = ~1 billion combos (was SAGE + 2 chars = 1,024)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

app.post("/api/seniors", rateLimit("login"), async (req, res) => {
  try {
    const { name, age, email, password } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!age) return res.status(400).json({ error: "Age is required" });
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    // Check if email already in use
    const { data: existing } = await supabase.from("seniors").select("id").eq("email", email.trim().toLowerCase()).limit(1);
    if (existing && existing.length > 0) return res.status(409).json({ error: "An account with this email already exists. Try signing in instead." });

    // Hash password
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
    const passwordHash = salt + ":" + hash;

    let familyCode;
    while (true) {
      familyCode = generateFamilyCode();
      const { data: exists } = await supabase.from("seniors").select("id").eq("family_code", familyCode).single();
      if (!exists) break;
    }

    const { data: senior } = await supabase.from("seniors").insert({
      name: name.trim(), age: age ? parseInt(age) : null,
      email: email.trim().toLowerCase(), password_hash: passwordHash,
      family_code: familyCode, conditions: [],
      preferences: { voiceSpeed: "normal", theme: "default" },
      last_active: new Date().toISOString(),
    }).select().single();

    await supabase.from("activity").insert({
      senior_id: senior.id, type: "system",
      description: `${name} joined Sage Companion`, timestamp: new Date().toISOString(),
    });

    // Issue a senior token so the user is logged in immediately after setup
    const token = makeSeniorToken(senior.id);
    console.log(`[Auth] ✅ New user registered: ${name}`);

    // Admin notification for new signup
    await supabase.from("alerts").insert({
      senior_id: senior.id, type: "signup",
      message: `New user registered: ${name} (${email.trim().toLowerCase()})`,
      severity: "info", resolved: false,
    }).catch(() => {});

    // Send welcome email with family code (non-blocking)
    sendWelcomeEmail(email.trim().toLowerCase(), name.trim(), familyCode).catch(e => {
      console.error("[Email] Welcome email failed:", e.message);
    });

    res.json({ success: true, senior: safeSenior(norm(senior)), token });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CRM API
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/admin/login", rateLimit("login"), (req, res) => {
  const { password } = req.body;
  const expected = process.env.ADMIN_PASSWORD || "admin123";
  console.log(`[Admin] Login attempt — match: ${password === expected}`);
  if (!password || password !== expected) {
    return res.status(401).json({ error: "Wrong password" });
  }
  res.json({ token: adminToken() });
});

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      { count: totalUsers },
      { count: activeToday },
      { count: chatsThisWeek },
      { count: totalEmergencies },
      { count: newThisWeek },
    ] = await Promise.all([
      supabase.from("seniors").select("*", { count: "exact", head: true }),
      supabase.from("seniors").select("*", { count: "exact", head: true }).gte("last_active", todayStart.toISOString()),
      supabase.from("conversations").select("*", { count: "exact", head: true }).eq("role", "user").gte("timestamp", weekAgo.toISOString()),
      supabase.from("alerts").select("*", { count: "exact", head: true }).eq("type", "emergency"),
      supabase.from("seniors").select("*", { count: "exact", head: true }).gte("created_at", weekAgo.toISOString()),
    ]);

    const { data: metricsData } = await supabase.from("usage_metrics").select("medications_taken");
    const medsThisWeek = (metricsData || []).reduce((s, r) => s + (r.medications_taken || 0), 0);

    const { count: totalAppointments } = await supabase.from("appointments").select("*", { count: "exact", head: true });

    res.json({ totalUsers, activeToday, chatsThisWeek, totalEmergencies, newThisWeek, medsThisWeek, totalAppointments });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const { data: seniors, error: sErr } = await supabase.from("seniors").select("*").order("created_at", { ascending: false });
    if (sErr) { console.error("[Admin] Users fetch error:", sErr.message); return res.status(500).json({ error: sErr.message }); }
    if (!seniors || !seniors.length) { return res.json([]); }

    // Fetch cost totals for all users in one query (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const { data: costRows } = await supabase
      .from("cost_log")
      .select("senior_id, cost_usd")
      .gte("date", thirtyDaysAgo);

    // Sum costs per senior
    const costBySenior = {};
    for (const c of (costRows || [])) {
      costBySenior[c.senior_id] = (costBySenior[c.senior_id] || 0) + (c.cost_usd || 0);
    }

    const enriched = seniors.map(s => ({
      ...norm(s),
      totalChats: 0,
      totalMeds: 0,
      openAlerts: 0,
      totalAppts: 0,
      totalDoctorQ: 0,
      cost30d: Math.round((costBySenior[s.id] || 0) * 100) / 100,
    }));

    console.log(`[Admin] Returning ${enriched.length} users`);
    res.json(enriched);
  } catch (e) { console.error("[Admin] Users error:", e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.get("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: senior } = await supabase.from("seniors").select("*").eq("id", id).single();
    if (!senior) return res.status(404).json({ error: "User not found" });

    const [
      { data: meds },
      { data: questions },
      { data: visits },
      { data: appts },
      { data: metrics },
      { data: activity },
    ] = await Promise.all([
      supabase.from("medications").select("*").eq("senior_id", id).eq("active", true),
      supabase.from("doctor_questions").select("*").eq("senior_id", id).order("created_at", { ascending: false }).limit(20),
      supabase.from("doctor_visits").select("id, doctor_name, word_count, created_at").eq("senior_id", id).order("created_at", { ascending: false }).limit(10),
      supabase.from("appointments").select("*").eq("senior_id", id).order("date", { ascending: true }).limit(20),
      supabase.from("usage_metrics").select("*").eq("senior_id", id).order("date", { ascending: false }).limit(30),
      supabase.from("activity").select("*").eq("senior_id", id).order("timestamp", { ascending: false }).limit(30),
    ]);

    // Aggregate totals for detail panel
    const [chatsCount, medsCount, emergCount, apptsCount, drqCount, visitsCount, costData] = await Promise.all([
      supabase.from("conversations").select("*", { count: "exact", head: true }).eq("senior_id", id).eq("role", "user"),
      supabase.from("med_log").select("*", { count: "exact", head: true }).eq("senior_id", id),
      supabase.from("alerts").select("*", { count: "exact", head: true }).eq("senior_id", id).eq("type", "emergency"),
      supabase.from("appointments").select("*", { count: "exact", head: true }).eq("senior_id", id),
      supabase.from("doctor_questions").select("*", { count: "exact", head: true }).eq("senior_id", id),
      supabase.from("doctor_visits").select("*", { count: "exact", head: true }).eq("senior_id", id),
      supabase.from("cost_log").select("date, call_type, cost_usd, input_tokens, output_tokens, tts_chars").eq("senior_id", id).order("date", { ascending: false }).limit(500),
    ]);

    // Calculate cost summaries
    const costs = costData.data || [];
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().split("T")[0];
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
    const todayStr = now.toISOString().split("T")[0];

    const costAllTime = costs.reduce((s, c) => s + (c.cost_usd || 0), 0);
    const cost30d = costs.filter(c => c.date >= thirtyDaysAgo).reduce((s, c) => s + (c.cost_usd || 0), 0);
    const cost7d = costs.filter(c => c.date >= sevenDaysAgo).reduce((s, c) => s + (c.cost_usd || 0), 0);
    const costToday = costs.filter(c => c.date === todayStr).reduce((s, c) => s + (c.cost_usd || 0), 0);

    // Cost breakdown by type
    const costByType = {};
    for (const c of costs) {
      if (!costByType[c.call_type]) costByType[c.call_type] = 0;
      costByType[c.call_type] += c.cost_usd || 0;
    }

    res.json({
      ...safeSenior(norm(senior)),
      medications:     normArr(meds),
      doctorQuestions: normArr(questions),
      doctorVisits:    normArr(visits),
      appointments:    normArr(appts),
      usageMetrics:    normArr(metrics),
      recentActivity:  normArr(activity),
      totalChats:        chatsCount.count ?? 0,
      totalMedsTaken:    medsCount.count ?? 0,
      totalEmergencies:  emergCount.count ?? 0,
      totalAppointments: apptsCount.count ?? 0,
      totalDrQuestions:  drqCount.count ?? 0,
      totalDoctorVisits: visitsCount.count ?? 0,
      costSummary: {
        allTime: Math.round(costAllTime * 100) / 100,
        last30d: Math.round(cost30d * 100) / 100,
        last7d:  Math.round(cost7d * 100) / 100,
        today:   Math.round(costToday * 100) / 100,
        byType:  costByType,
      },
    });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.get("/api/admin/alerts", adminAuth, async (req, res) => {
  try {
    const { data: alerts } = await supabase
      .from("alerts")
      .select("*, seniors(name)")
      .order("created_at", { ascending: false })
      .limit(100);

    const enriched = (alerts || []).map(a => ({
      ...norm(a),
      userName: a.seniors?.name || "Unknown",
    }));
    res.json(enriched);
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Suspend / unsuspend a user
app.post("/api/admin/users/:id/suspend", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { suspended } = req.body; // true to suspend, false to unsuspend
    const { data: senior, error } = await supabase.from("seniors").update({ suspended: !!suspended }).eq("id", id).select("id, name, email").single();
    if (error) return res.status(400).json({ error: error.message });

    // Log the action as an alert
    await supabase.from("alerts").insert({
      senior_id: id,
      type: suspended ? "suspension" : "reactivation",
      message: `User ${suspended ? "suspended" : "reactivated"}: ${senior.name || "Unknown"} (${senior.email || id})`,
      severity: suspended ? "warning" : "info",
      resolved: true,
    }).catch(() => {});

    console.log(`[Admin] User ${id} ${suspended ? "suspended" : "reactivated"}`);
    res.json({ success: true, suspended: !!suspended });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ── Delete user (admin) ──────────────────────────────────────────────────────
app.delete("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify user exists
    const { data: senior } = await supabase.from("seniors").select("id, name").eq("id", id).single();
    if (!senior) return res.status(404).json({ error: "User not found" });

    // Delete all related data in order (foreign key dependencies)
    const tables = [
      "push_subscriptions", "usage_metrics", "memories", "cost_log",
      "conversations", "med_log", "medications", "doctor_questions",
      "doctor_visits", "appointments", "reminders", "activity", "alerts",
    ];
    for (const table of tables) {
      await supabase.from(table).delete().eq("senior_id", id);
    }

    // Finally delete the senior record
    await supabase.from("seniors").delete().eq("id", id);

    console.log(`[Admin] Deleted user ${senior.name} (${id}) and all related data`);
    res.json({ success: true });
  } catch (e) {
    console.error("[Admin] Delete user error:", e.message);
    res.status(500).json({ error: "Failed to delete user: " + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Senior login — email+password OR family code → 90-day senior token
app.post("/api/senior/login", rateLimit("login"), async (req, res) => {
  try {
    const { familyCode, email, password } = req.body;
    let senior;

    if (email && password) {
      // Email + password login
      const { data } = await supabase.from("seniors").select("*")
        .eq("email", email.trim().toLowerCase()).single();
      if (!data) return res.status(401).json({ error: "Invalid email or password." });

      // Verify password
      if (!data.password_hash) return res.status(401).json({ error: "This account was created before passwords were required. Please use your family code to sign in." });
      const [salt, storedHash] = data.password_hash.split(":");
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
      if (hash !== storedHash) return res.status(401).json({ error: "Invalid email or password." });
      senior = data;
    } else if (familyCode) {
      // Family code login
      const { data } = await supabase.from("seniors").select("*")
        .eq("family_code", familyCode.trim().toUpperCase()).single();
      if (!data) return res.status(401).json({ error: "Invalid code. Please check and try again." });
      senior = data;
    } else {
      return res.status(400).json({ error: "Email and password, or family code required." });
    }

    const token = makeSeniorToken(senior.id);
    console.log(`[Auth] Senior login: ${senior.name} (${senior.id})`);
    res.json({ token, senior: safeSenior(norm(senior)), expiresInDays: SENIOR_TOKEN_DAYS });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Family login — exchange family code for a 30-day family token
app.post("/api/family/login", rateLimit("login"), async (req, res) => {
  try {
    const { familyCode } = req.body;
    if (!familyCode) return res.status(400).json({ error: "Family code required" });

    const { data: senior } = await supabase
      .from("seniors")
      .select("*")
      .eq("family_code", familyCode.trim().toUpperCase())
      .single();

    if (!senior) return res.status(401).json({ error: "Invalid family code" });

    const token = makeFamilyToken(senior.id);
    console.log(`[Auth] Family login: ${senior.name}`);
    res.json({ token, senior: safeSenior(norm(senior)), expiresInDays: FAMILY_TOKEN_DAYS });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

// Return VAPID public key to client (needed for subscription)
app.get("/api/push/key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || null });
});

// Save a push subscription for a senior
app.post("/api/push/subscribe", seniorAuth, async (req, res) => {
  try {
    const { subscription, seniorId, deviceLabel } = req.body;
    if (!subscription || !seniorId) return res.status(400).json({ error: "subscription and seniorId required" });

    const subJson = JSON.stringify(subscription);

    // Upsert by endpoint — avoid duplicates
    const { data: existing } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("senior_id", seniorId)
      .eq("subscription_json", subJson)
      .maybeSingle();

    if (existing) {
      await supabase.from("push_subscriptions")
        .update({ last_used: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await supabase.from("push_subscriptions").insert({
        senior_id:         seniorId,
        subscription_json: subJson,
        device_label:      deviceLabel || "Unknown device",
      });
    }

    res.json({ ok: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Remove a push subscription
app.post("/api/push/unsubscribe", seniorAuth, async (req, res) => {
  try {
    const { seniorId } = req.body;
    if (!seniorId) return res.status(400).json({ error: "seniorId required" });
    await supabase.from("push_subscriptions").delete().eq("senior_id", seniorId);
    res.json({ ok: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Send a test push notification
app.post("/api/push/test", seniorAuth, async (req, res) => {
  try {
    const { seniorId } = req.body;
    if (!seniorId) return res.status(400).json({ error: "seniorId required" });
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.status(400).json({ error: "Push not configured" });

    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("id, subscription_json")
      .eq("senior_id", seniorId);

    if (!subs || !subs.length) return res.status(404).json({ error: "No subscriptions found" });

    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          JSON.parse(sub.subscription_json),
          JSON.stringify({
            title: "🌿 Sage Reminders Active",
            body:  "You'll now get medication reminders at the right time. Great!",
            icon:  "/icons/icon-192.png",
            badge: "/icons/badge-72.png",
            tag:   "sage-test",
          })
        );
        sent++;
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
      }
    }
    res.json({ ok: true, sent });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ── Contact form ────────────────────────────────────────────────────────────
app.post("/api/contact", rateLimit("login"), async (req, res) => {
  try {
    const { name, email, topic, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: "Name, email, and message are required" });

    // Store in Supabase
    await supabase.from("contact_messages").insert({
      name, email, topic: topic || "general", message,
    }).then(({ error }) => { if (error) console.error("[Contact] DB insert:", error.message); });

    // Send email notification to admin
    if (resend) {
      resend.emails.send({
        from: FROM_EMAIL,
        to: process.env.ADMIN_EMAIL || "support@mysagecompanion.com",
        replyTo: email,
        subject: `[Sage Contact] ${topic || "General"} — from ${name}`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
            <h2 style="color:#1E3A8A;">New Contact Form Message</h2>
            <p><strong>From:</strong> ${name} (${email})</p>
            <p><strong>Topic:</strong> ${topic || "General"}</p>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:16px 0;">
            <p style="font-size:16px;line-height:1.6;white-space:pre-wrap;">${message}</p>
          </div>
        `,
      }).catch(e => console.error("[Contact] Email send:", e.message));
    }

    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/elder",          (req, res) => res.sendFile(path.join(__dirname, "public", "elder.html")));
app.get("/family",         (req, res) => res.sendFile(path.join(__dirname, "public", "family.html")));
app.get("/doctor",         (req, res) => res.sendFile(path.join(__dirname, "public", "doctor.html")));
app.get("/calendar",       (req, res) => res.sendFile(path.join(__dirname, "public", "calendar.html")));
app.get("/setup",          (req, res) => res.sendFile(path.join(__dirname, "public", "setup.html")));
app.get("/admin",          (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/settings",       (req, res) => res.sendFile(path.join(__dirname, "public", "settings.html")));
app.get("/help",           (req, res) => res.sendFile(path.join(__dirname, "public", "help.html")));
app.get("/contact",        (req, res) => res.sendFile(path.join(__dirname, "public", "contact.html")));
app.get("/terms",          (req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));
app.get("/privacy",        (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.get("/reset-password", (req, res) => res.sendFile(path.join(__dirname, "public", "reset-password.html")));
app.get("/",               (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE PAYMENT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Create checkout session for subscription
app.post("/api/billing/checkout", seniorAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Payments not configured yet. Coming soon!" });
  try {
    const { plan } = req.body; // "monthly" or "yearly"
    const priceId = plan === "yearly" ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(400).json({ error: "Pricing not configured" });

    const { data: senior } = await supabase.from("seniors").select("*").eq("id", req.seniorId).single();
    if (!senior) return res.status(404).json({ error: "Account not found" });

    const sessionParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { seniorId: req.seniorId, plan },
      },
      success_url: `${req.protocol}://${req.get("host")}/settings?billing=success`,
      cancel_url: `${req.protocol}://${req.get("host")}/settings?billing=cancelled`,
      metadata: { seniorId: req.seniorId, plan },
      customer_email: senior.email,
    };

    // Reuse existing Stripe customer if available — skip trial if they already had one
    if (senior.stripe_customer_id) {
      sessionParams.customer = senior.stripe_customer_id;
      delete sessionParams.customer_email;
      delete sessionParams.subscription_data.trial_period_days; // no second free trial
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    console.error("[Stripe] Checkout error:", e.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Get subscription status
app.get("/api/billing/status", seniorAuth, async (req, res) => {
  try {
    const { data: senior } = await supabase.from("seniors").select("subscription_status, subscription_plan, stripe_customer_id, trial_ends_at").eq("id", req.seniorId).single();
    if (!senior) return res.status(404).json({ error: "Account not found" });
    res.json({
      status: senior.subscription_status || "none",
      plan: senior.subscription_plan || "none",
      trialEndsAt: senior.trial_ends_at || null,
      hasStripe: !!senior.stripe_customer_id,
    });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Stripe billing portal (manage subscription, update card, cancel)
app.post("/api/billing/portal", seniorAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Payments not configured yet" });
  try {
    const { data: senior } = await supabase.from("seniors").select("stripe_customer_id").eq("id", req.seniorId).single();
    if (!senior?.stripe_customer_id) return res.status(400).json({ error: "No active subscription" });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: senior.stripe_customer_id,
      return_url: `${req.protocol}://${req.get("host")}/settings`,
    });
    res.json({ url: portalSession.url });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Send welcome email with family code (called after signup)
async function sendWelcomeEmail(email, name, familyCode) {
  if (!resend) { console.log("[Email] Resend not configured — skipping welcome email"); return; }
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Welcome to Sage, ${name}!`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
          <div style="text-align:center;margin-bottom:24px;">
            <span style="font-size:48px;">🌿</span>
            <h1 style="color:#1E3A8A;font-size:28px;margin:12px 0 0;">Welcome to Sage</h1>
          </div>
          <p style="font-size:18px;color:#333;line-height:1.6;">Hi ${name},</p>
          <p style="font-size:18px;color:#333;line-height:1.6;">Your Sage Companion account is all set up! Here's your family code — share it with your loved ones so they can stay connected:</p>
          <div style="background:#1E3A8A;border-radius:16px;padding:24px;text-align:center;margin:24px 0;">
            <div style="color:rgba(255,255,255,0.7);font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Your Family Code</div>
            <div style="color:white;font-size:36px;font-weight:900;letter-spacing:6px;">${familyCode}</div>
          </div>
          <p style="font-size:16px;color:#666;line-height:1.6;">Family members can use this code at the Family Dashboard to check in on your wellbeing, see your medications, and stay up to date.</p>
          <p style="font-size:16px;color:#666;line-height:1.6;">If you ever forget your family code, you can find it in your Settings page or request it via email from the login screen.</p>
          <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;">
          <p style="font-size:14px;color:#999;text-align:center;">Sage Companion LLC — Always here for you.</p>
        </div>
      `,
    });
    console.log(`[Email] Welcome email sent to ${email}`);
  } catch (e) { console.error("[Email] Failed to send welcome:", e.message); }
}

// Forgot family code — sends code to registered email
app.post("/api/auth/forgot-code", rateLimit("login"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const { data: senior } = await supabase.from("seniors").select("name, family_code, email")
      .eq("email", email.trim().toLowerCase()).single();

    // Always return success (don't reveal if email exists)
    if (!senior) return res.json({ success: true, message: "If an account exists with that email, we'll send your family code." });

    if (resend) {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: senior.email,
        subject: "Your Sage Family Code",
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
            <div style="text-align:center;margin-bottom:24px;">
              <span style="font-size:48px;">🌿</span>
              <h1 style="color:#1E3A8A;font-size:24px;margin:12px 0 0;">Your Family Code</h1>
            </div>
            <p style="font-size:18px;color:#333;line-height:1.6;">Hi ${senior.name},</p>
            <p style="font-size:18px;color:#333;line-height:1.6;">Here's your family code:</p>
            <div style="background:#1E3A8A;border-radius:16px;padding:24px;text-align:center;margin:24px 0;">
              <div style="color:white;font-size:36px;font-weight:900;letter-spacing:6px;">${senior.family_code}</div>
            </div>
            <p style="font-size:16px;color:#666;">Share this with family members so they can connect to your Sage dashboard.</p>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;">
            <p style="font-size:14px;color:#999;text-align:center;">Sage Companion LLC</p>
          </div>
        `,
      });
      console.log(`[Email] Family code sent to ${email}`);
    }
    res.json({ success: true, message: "If an account exists with that email, we'll send your family code." });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Password reset — sends reset token via email
app.post("/api/auth/forgot-password", rateLimit("login"), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const { data: senior } = await supabase.from("seniors").select("id, name, email")
      .eq("email", email.trim().toLowerCase()).single();

    // Always return success
    if (!senior) return res.json({ success: true });

    // Generate reset token (valid 1 hour)
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await supabase.from("seniors").update({ reset_token: resetToken, reset_expires: resetExpires }).eq("id", senior.id);

    if (resend) {
      const resetUrl = `${req.protocol}://${req.get("host")}/reset-password?token=${resetToken}`;
      await resend.emails.send({
        from: FROM_EMAIL,
        to: senior.email,
        subject: "Reset Your Sage Password",
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
            <div style="text-align:center;margin-bottom:24px;">
              <span style="font-size:48px;">🌿</span>
              <h1 style="color:#1E3A8A;font-size:24px;margin:12px 0 0;">Reset Your Password</h1>
            </div>
            <p style="font-size:18px;color:#333;line-height:1.6;">Hi ${senior.name},</p>
            <p style="font-size:18px;color:#333;line-height:1.6;">Click the button below to reset your password. This link expires in 1 hour.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${resetUrl}" style="display:inline-block;background:#1E3A8A;color:white;text-decoration:none;padding:16px 36px;border-radius:14px;font-size:18px;font-weight:700;">Reset Password</a>
            </div>
            <p style="font-size:14px;color:#999;">If you didn't request this, you can safely ignore this email.</p>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;">
            <p style="font-size:14px;color:#999;text-align:center;">Sage Companion LLC</p>
          </div>
        `,
      });
      console.log(`[Email] Password reset sent to ${email}`);
    }
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Reset password with token
app.post("/api/auth/reset-password", rateLimit("login"), async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 6) return res.status(400).json({ error: "Valid token and password (6+ chars) required" });

    const { data: senior } = await supabase.from("seniors").select("id, reset_token, reset_expires")
      .eq("reset_token", token).single();
    if (!senior) return res.status(400).json({ error: "Invalid or expired reset link" });
    if (new Date(senior.reset_expires) < new Date()) return res.status(400).json({ error: "Reset link has expired. Please request a new one." });

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
    await supabase.from("seniors").update({
      password_hash: salt + ":" + hash,
      reset_token: null,
      reset_expires: null,
    }).eq("id", senior.id);

    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS / ACCOUNT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Get account info for settings page
app.get("/api/account", seniorAuth, async (req, res) => {
  try {
    const { data: senior } = await supabase.from("seniors").select("name, email, age, family_code, subscription_status, subscription_plan, created_at, location").eq("id", req.seniorId).single();
    if (!senior) return res.status(404).json({ error: "Account not found" });
    res.json(norm(senior));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Change password
app.post("/api/account/change-password", seniorAuth, rateLimit("login"), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });

    const { data: senior } = await supabase.from("seniors").select("password_hash").eq("id", req.seniorId).single();
    if (!senior) return res.status(404).json({ error: "Account not found" });

    // Verify current password if one exists
    if (senior.password_hash && currentPassword) {
      const [salt, storedHash] = senior.password_hash.split(":");
      const hash = crypto.pbkdf2Sync(currentPassword, salt, 100000, 64, "sha512").toString("hex");
      if (hash !== storedHash) return res.status(401).json({ error: "Current password is incorrect" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(newPassword, salt, 100000, 64, "sha512").toString("hex");
    await supabase.from("seniors").update({ password_hash: salt + ":" + hash }).eq("id", req.seniorId);

    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Update name
app.post("/api/account/change-name", seniorAuth, rateLimit("api"), async (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName || !newName.trim()) return res.status(400).json({ error: "Name is required" });
    const trimmed = newName.trim();
    if (trimmed.length > 100) return res.status(400).json({ error: "Name must be under 100 characters" });

    await supabase.from("seniors").update({ name: trimmed }).eq("id", req.seniorId);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Update location (manual fallback)
app.post("/api/account/change-location", seniorAuth, rateLimit("api"), async (req, res) => {
  try {
    const { location } = req.body;
    const trimmed = (location || "").trim();
    if (!trimmed) return res.status(400).json({ error: "City/location is required" });
    if (trimmed.length > 150) return res.status(400).json({ error: "Location must be under 150 characters" });

    await supabase.from("seniors").update({ location: trimmed }).eq("id", req.seniorId);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Update email
app.post("/api/account/change-email", seniorAuth, rateLimit("login"), async (req, res) => {
  try {
    const { newEmail, password } = req.body;
    if (!newEmail) return res.status(400).json({ error: "New email required" });

    // Verify password
    const { data: senior } = await supabase.from("seniors").select("password_hash").eq("id", req.seniorId).single();
    if (senior?.password_hash && password) {
      const [salt, storedHash] = senior.password_hash.split(":");
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
      if (hash !== storedHash) return res.status(401).json({ error: "Password is incorrect" });
    }

    // Check if email taken
    const { data: existing } = await supabase.from("seniors").select("id").eq("email", newEmail.trim().toLowerCase()).limit(1);
    if (existing && existing.length > 0) return res.status(409).json({ error: "This email is already in use" });

    await supabase.from("seniors").update({ email: newEmail.trim().toLowerCase() }).eq("id", req.seniorId);
    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Delete account
app.post("/api/account/delete", seniorAuth, rateLimit("login"), async (req, res) => {
  try {
    const { password, confirmation } = req.body;
    if (confirmation !== "DELETE") return res.status(400).json({ error: 'Please type "DELETE" to confirm' });

    // Verify password
    const { data: senior } = await supabase.from("seniors").select("id, password_hash, stripe_customer_id, name").eq("id", req.seniorId).single();
    if (!senior) return res.status(404).json({ error: "Account not found" });

    if (senior.password_hash && password) {
      const [salt, storedHash] = senior.password_hash.split(":");
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
      if (hash !== storedHash) return res.status(401).json({ error: "Password is incorrect" });
    }

    // Cancel Stripe subscription if exists
    if (stripe && senior.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({ customer: senior.stripe_customer_id, status: "active" });
        for (const sub of subs.data) { await stripe.subscriptions.cancel(sub.id); }
      } catch (e) { console.error("[Stripe] Error cancelling subscription:", e.message); }
    }

    // Delete all user data (cascades via foreign keys)
    await supabase.from("seniors").delete().eq("id", req.seniorId);
    console.log(`[Account] Deleted account: ${senior.name} (${req.seniorId})`);

    res.json({ success: true });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  // ── Production safety checks ────────────────────────────────────────────────
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL === "YOUR_SUPABASE_URL") {
    console.warn("\n⚠️  SUPABASE_URL not configured — see .env file for setup instructions.\n");
  } else {
    await seedIfEmpty();
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "admin123") {
    console.warn("⚠️  ADMIN_PASSWORD is using the default — set a strong password in env vars!");
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "sage-family-secret-dev") {
    console.warn("⚠️  JWT_SECRET is using the default — set a unique secret in env vars!");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  ANTHROPIC_API_KEY not set — chat will not work.");
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY not set — voice TTS will fall back to browser speech.");
  }
  app.listen(PORT, () => {
    console.log("\n🌿  Sage Companion LLC is running!\n");
    console.log(`   🌐 Home:          http://localhost:${PORT}`);
    console.log(`   👵 Senior view:   http://localhost:${PORT}/elder`);
    console.log(`   👨‍👩‍👧 Family view:  http://localhost:${PORT}/family`);
    console.log(`   🔐 Admin CRM:     http://localhost:${PORT}/admin`);
    console.log(`\n   Demo family code: FAMILY123`);
    console.log(`   📧 Resend:        ${resend ? "configured ✅" : "NOT configured ❌"}`);
    console.log(`   💳 Stripe:        ${stripe ? "configured ✅" : "NOT configured ❌"}`);
    console.log("\n   Press Ctrl+C to stop\n");

    // Start push notification cron jobs — all check every minute
    if (VAPID_PUBLIC && VAPID_PRIVATE) {
      cron.schedule("* * * * *", checkMedicationReminders);
      cron.schedule("* * * * *", checkAppointmentReminders);
      cron.schedule("* * * * *", checkDueReminders);
      cron.schedule("0 9 * * *", checkRefillReminders); // daily at 9 AM
      console.log("   💊 Medication reminders: active");
      console.log("   📅 Appointment reminders: active (1hr + 15min before)");
      console.log("   🔔 Due reminders: active");
      console.log("   💊 Refill reminders: active (daily at 9 AM)\n");
    } else {
      console.log("   💊 Medication reminders: disabled (VAPID keys not set)");
      console.log("   📅 Appointment reminders: disabled");
      console.log("   🔔 Due reminders: disabled\n");
    }
  });
}

start().catch(console.error);

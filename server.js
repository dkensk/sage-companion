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
  } catch {}
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
async function checkMedicationReminders() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // Push not configured
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL === "YOUR_SUPABASE_PROJECT_URL") return;

  try {
    const now         = new Date();
    const currentTime = now.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
    }); // e.g. "8:00 AM"

    // Get all active medications scheduled for right now
    const { data: meds } = await supabase
      .from("medications")
      .select("id, name, dose, senior_id")
      .eq("active", true)
      .eq("time", currentTime);

    if (!meds || !meds.length) return;

    const today    = now.toISOString().split("T")[0];
    const todayStart = today + "T00:00:00.000Z";

    for (const med of meds) {
      // Skip if already taken today
      const { count: taken } = await supabase
        .from("med_log")
        .select("*", { count: "exact", head: true })
        .eq("senior_id", med.senior_id)
        .eq("medication_id", med.id)
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
              body:         `It's time to take ${med.name}${med.dose ? " (" + med.dose + ")" : ""}`,
              icon:         "/icons/icon-192.png",
              badge:        "/icons/badge-72.png",
              tag:          `med-${med.id}-${today}`,
              medicationId: med.id,
              seniorId:     med.senior_id,
            })
          );
          // Update last_used timestamp
          await supabase.from("push_subscriptions")
            .update({ last_used: new Date().toISOString() })
            .eq("id", sub.id);
        } catch (e) {
          // Subscription expired or invalid — remove it
          if (e.statusCode === 410 || e.statusCode === 404) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }
    }
  } catch (e) {
    // Non-critical — don't crash server
    console.error("Reminder check error:", e.message);
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
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://js.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://api.stripe.com https://nominatim.openstreetmap.org; frame-src https://js.stripe.com;");
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
    res.json(norm(data));
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

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { data: logs } = await supabase.from("med_log").select("medication_id")
      .eq("senior_id", req.params.seniorId)
      .gte("taken_at", todayStart.toISOString());

    const takenIds = new Set((logs || []).map(l => l.medication_id));
    res.json(normArr(meds).map(m => ({ ...m, takenToday: takenIds.has(m.id) })));
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.post("/api/medications/:id/taken", seniorAuth, validateUUID("id"), async (req, res) => {
  try {
    const { data: med } = await supabase.from("medications").select("*")
      .eq("id", req.params.id).single();
    if (!med) return res.status(404).json({ error: "Medication not found" });

    await supabase.from("med_log").insert({
      senior_id: med.senior_id, medication_id: med.id,
      medication_name: med.name, taken_at: new Date().toISOString(),
    });
    await supabase.from("activity").insert({
      senior_id: med.senior_id, type: "medication_taken",
      description: `Took ${med.name} ${med.dose || ""}`, timestamp: new Date().toISOString(),
    });
    await trackUsage(med.senior_id, "medications_taken");
    res.json({ success: true, message: `${med.name} marked as taken` });
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
app.post("/api/medications/scan", rateLimit("upload"), upload.single("image"), seniorAuth, async (req, res) => {
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
- "time": best time to take — infer from directions e.g. "once daily in the morning" → "8:00 AM", "at bedtime" → "9:00 PM" (string or null)
- "withFood": true if label says "take with food" or "take with meals" (boolean, default false)
- "directions": the full directions text as written (string or null)
- "prescriber": doctor name if visible on label (string or null)
- "refills": number of refills remaining as a number (number or null)` }
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
app.post("/api/medications", anyAuth, async (req, res) => {
  try {
    const { seniorId, name, dose, time, withFood } = req.body;
    if (!seniorId || !name) return res.status(400).json({ error: "seniorId and name required" });

    const { data: med } = await supabase.from("medications").insert({
      senior_id: seniorId, name, dose: dose || null,
      time: time || null, with_food: !!withFood, active: true,
    }).select().single();

    await supabase.from("activity").insert({
      senior_id: seniorId, type: "medication_added",
      description: `Medication added: ${name}${dose ? " " + dose : ""}`,
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true, medication: norm(med) });
  } catch (e) { console.error(`[Error] ${req.method} ${req.path}:`, e.message); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

app.delete("/api/medications/:id", seniorAuth, validateUUID("id"), async (req, res) => {
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

app.post("/api/chat", seniorAuth, suspendCheck, rateLimit(60000, 20), async (req, res) => {
  try {
    const { seniorId, message, sessionId, clientTime, timezone, location } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    const effectiveSeniorId = seniorId || DEMO_SENIOR_ID;

    const { data: senior } = await supabase.from("seniors").select("*")
      .eq("id", effectiveSeniorId).single();
    const seniorName = senior?.name || "Friend";
    const conditions = (senior?.conditions || []).join(", ");

    const { data: meds } = await supabase.from("medications").select("*")
      .eq("senior_id", effectiveSeniorId).eq("active", true);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { data: logs } = await supabase.from("med_log").select("medication_id")
      .eq("senior_id", effectiveSeniorId).gte("taken_at", todayStart.toISOString());
    const takenIds = new Set((logs || []).map(l => l.medication_id));
    const medSummary = (meds || []).map(m =>
      `- ${m.name} ${m.dose || ""} at ${m.time || ""}${m.with_food ? " (with food)" : ""}: ${takenIds.has(m.id) ? "taken" : "not yet taken"}`
    ).join("\n");

    const { data: historyRows } = await supabase.from("conversations").select("role, content")
      .eq("senior_id", effectiveSeniorId).order("timestamp", { ascending: false }).limit(20);
    const recentHistory = (historyRows || []).reverse();

    // Fetch weather if location provided and message seems weather-related
    let weatherInfo = null;
    const weatherKeywords = /weather|temperature|outside|warm|cold|rain|sunny|snow|hot|degrees|forecast/i;
    if (location && weatherKeywords.test(message)) {
      try {
        weatherInfo = await new Promise((resolve) => {
          const https = require("https");
          const city  = encodeURIComponent(location);
          https.get(`https://wttr.in/${city}?format=3`, (r) => {
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

    const systemPrompt = `You are Sage, a warm, caring, and supportive AI companion for ${seniorName}, a ${senior?.age || ""}year-old.

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

When ${seniorName} asks about symptoms, medications, medical concerns, or anything health-related:
1. Acknowledge their concern warmly
2. Gently explain: "I'm not able to give medical advice, but that's really a question for your doctor."
3. End your response with: [ASK_DOCTOR: <a clear question to ask their doctor>]

For true emergencies like chest pain, difficulty breathing, or a fall: Always say to call 911 or press the emergency button right away.

APPOINTMENTS & CALENDAR:
When ${seniorName} mentions an upcoming appointment, event, or anything that should go on a calendar (doctor visits, lunch plans, birthdays, errands, etc.):
1. Confirm what you heard back to them warmly, for example: "Got it, I've added your dentist appointment on Thursday at 2 PM to your calendar!"
2. At the very END of your response, add a structured tag: [APPOINTMENT: {"title": "...", "date": "YYYY-MM-DD", "time": "2:00 PM" or null, "location": "..." or null, "notes": "..." or null}]
3. Use the current date/time context below to figure out the correct YYYY-MM-DD date. For example, if today is Monday Feb 27 and they say "this Thursday", that is March 2.
4. If they do NOT give enough info to determine a date (just "sometime" or "eventually"), ask them gently what day it is, do NOT output the tag.
5. The tag is machine-parsed and NEVER read aloud — the user only hears your friendly confirmation.

Today's medication status:
${medSummary || "No medications scheduled today"}

Current time: ${clientTime || new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
Today: ${timezone ? new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone }) : new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
${location ? `User's location: ${location}` : ""}
${weatherInfo ? `Current weather: ${weatherInfo}` : ""}`;

    // Haiku is 10-20x faster than Opus — ideal for conversational voice responses
    const chatModel = process.env.CHAT_MODEL || "claude-haiku-4-5-20251001";
    const response = await anthropic.messages.create({
      model: chatModel,
      max_tokens: 300,
      system: systemPrompt,
      messages,
    });

    const rawReply = response.content[0].text;

    // Extract structured tags before cleaning reply
    const askDoctorMatch = rawReply.match(/\[ASK_DOCTOR:\s*(.+?)\]/s);
    const suggestedQuestion = askDoctorMatch ? askDoctorMatch[1].trim() : null;

    const appointmentMatch = rawReply.match(/\[APPOINTMENT:\s*(\{[\s\S]*?\})\]/);
    let savedAppointment = null;
    if (appointmentMatch) {
      try {
        const apptData = JSON.parse(appointmentMatch[1]);
        if (apptData.title && apptData.date) {
          const { data: appt } = await supabase.from("appointments").insert({
            senior_id: effectiveSeniorId,
            title: apptData.title,
            date: apptData.date,
            time: apptData.time || null,
            location: apptData.location || "",
            notes: apptData.notes || "",
            source: "voice",
            google_event_id: null,
          }).select().single();
          if (appt) {
            savedAppointment = { id: appt.id, title: apptData.title, date: apptData.date, time: apptData.time || null, location: apptData.location || null };
            await supabase.from("activity").insert({
              senior_id: effectiveSeniorId, type: "appointment_added",
              description: `Voice appointment: ${apptData.title} on ${apptData.date}`,
              timestamp: new Date().toISOString(),
            });
            await trackUsage(effectiveSeniorId, "appointments_added");
          }
        }
      } catch (parseErr) {
        console.error("Appointment parse error:", parseErr.message);
      }
    }

    // Clean all tags from the spoken reply
    const aiReply = rawReply
      .replace(/\[ASK_DOCTOR:\s*.+?\]/s, "")
      .replace(/\[APPOINTMENT:\s*\{[\s\S]*?\}\]/, "")
      .trim();

    const sid = sessionId || uuidv4();
    await supabase.from("conversations").insert([
      { senior_id: effectiveSeniorId, session_id: sid, role: "user",      content: message,  timestamp: new Date().toISOString() },
      { senior_id: effectiveSeniorId, session_id: sid, role: "assistant", content: aiReply,  timestamp: new Date().toISOString() },
    ]);
    await supabase.from("activity").insert({
      senior_id: effectiveSeniorId, type: "conversation",
      description: `Chat: "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`,
      timestamp: new Date().toISOString(),
    });
    await trackUsage(effectiveSeniorId, "chat_messages");

    res.json({ reply: aiReply, sessionId: sid, suggestedQuestion, appointment: savedAppointment });
  } catch (e) {
    console.error("Chat error:", e.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
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
    voice: process.env.TTS_VOICE || "nova",
    issue: isPlaceholder ? "OPENAI_API_KEY is missing or still a placeholder" : null,
  });
});

// Live test endpoint — makes a real 1-word TTS call to verify the full pipeline (admin only)
app.get("/api/tts/test", adminAuth, async (req, res) => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("YOUR_") || apiKey.length < 20) {
    return res.json({ ok: false, error: "OPENAI_API_KEY not configured" });
  }
  const https = require("https");
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

app.post("/api/tts", seniorAuth, rateLimit(60000, 30), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("YOUR_") || apiKey.length < 20) {
    console.warn("TTS: OPENAI_API_KEY not set or placeholder");
    return res.status(503).json({ error: "OpenAI TTS not configured — add OPENAI_API_KEY to Railway Variables" });
  }

  // gpt-4o-mini-tts voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse
  // coral = cheerful & warm, sage = calm & thoughtful — both great for elder care
  const voice = (process.env.TTS_VOICE || "coral").trim();
  const cleanText = text.slice(0, 4096); // OpenAI max is 4096 chars

  console.log(`TTS request: voice=${voice}, text length=${cleanText.length}`);

  const https = require("https");

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
            console.error(`OpenAI TTS ${ttsRes.statusCode}: ${errBody.slice(0, 300)}`);
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
    console.error("TTS failed:", e.message);
    res.status(502).json({ error: "Voice synthesis failed. Please try again." });
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

// Deprecated — login by name removed for security. Use email+password or family code.
// app.get("/api/senior/by-name/:name", ...);

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
    const adherence  = (meds || []).length > 0 ? Math.round((takenToday / meds.length) * 100) : 0;

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

app.post("/api/appointments", seniorAuth, async (req, res) => {
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
    const { data: senior } = await supabase.from("seniors").select("name").eq("id", seniorId).single();
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
      "X-WR-TIMEZONE:America/Chicago",
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
    const { data: senior } = await supabase.from("seniors").select("*").eq("id", seniorId).single();
    if (!senior?.google_tokens) return res.status(401).json({ error: "Google not connected" });

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
    });

    let pulled = 0;
    for (const ev of (gRes.data.items || [])) {
      if (!ev.summary) continue;
      const startRaw  = ev.start.dateTime || ev.start.date;
      const startDate = new Date(startRaw);
      const dateStr   = startDate.toISOString().split("T")[0];
      const timeStr   = ev.start.dateTime ? startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
      const { data: existing } = await supabase.from("appointments").select("id").eq("google_event_id", ev.id).eq("senior_id", seniorId).single();
      if (existing) {
        await supabase.from("appointments").update({ title: ev.summary, date: dateStr, time: timeStr, location: ev.location || "", notes: ev.description || "" }).eq("id", existing.id);
      } else {
        await supabase.from("appointments").insert({ senior_id: seniorId, title: ev.summary, date: dateStr, time: timeStr, location: ev.location || "", notes: ev.description || "", source: "google", google_event_id: ev.id });
        pulled++;
      }
    }

    let pushed = 0;
    const { data: local } = await supabase.from("appointments").select("*").eq("senior_id", seniorId).is("google_event_id", null);
    for (const appt of (local || [])) {
      try {
        const startDT = new Date(appt.date + (appt.time ? " " + appt.time : "T09:00:00"));
        const endDT   = new Date(startDT.getTime() + 60 * 60 * 1000);
        const event = {
          summary: appt.title, location: appt.location || "", description: appt.notes || "",
          start: appt.time ? { dateTime: startDT.toISOString() } : { date: appt.date },
          end:   appt.time ? { dateTime: endDT.toISOString()   } : { date: appt.date },
        };
        const created = await cal.events.insert({ calendarId: "primary", resource: event });
        await supabase.from("appointments").update({ google_event_id: created.data.id }).eq("id", appt.id);
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
    console.error("Google sync error:", e.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING — Create senior profile
// ─────────────────────────────────────────────────────────────────────────────

function generateFamilyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return "SAGE" + Array.from({ length: 2 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
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
    console.log(`✅ New user: ${name} | Family code: ${familyCode}`);

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
  console.log(`[Admin] Login attempt — password length: ${password?.length || 0}, expected length: ${expected.length}, match: ${password === expected}`);
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

    // Return users with basic info — no count queries that could fail or time out
    const enriched = seniors.map(s => ({
      ...norm(s),
      totalChats: 0,
      totalMeds: 0,
      openAlerts: 0,
      totalAppts: 0,
      totalDoctorQ: 0,
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
    const totalChats        = (await supabase.from("conversations").select("*", { count: "exact", head: true }).eq("senior_id", id).eq("role", "user")).count ?? 0;
    const totalMedsTaken    = (await supabase.from("med_log").select("*", { count: "exact", head: true }).eq("senior_id", id)).count ?? 0;
    const totalEmergencies  = (await supabase.from("alerts").select("*", { count: "exact", head: true }).eq("senior_id", id).eq("type", "emergency")).count ?? 0;
    const totalAppointments = (await supabase.from("appointments").select("*", { count: "exact", head: true }).eq("senior_id", id)).count ?? 0;
    const totalDrQuestions  = (await supabase.from("doctor_questions").select("*", { count: "exact", head: true }).eq("senior_id", id)).count ?? 0;
    const totalDoctorVisits = (await supabase.from("doctor_visits").select("*", { count: "exact", head: true }).eq("senior_id", id)).count ?? 0;

    res.json({
      ...safeSenior(norm(senior)),
      medications:     normArr(meds),
      doctorQuestions: normArr(questions),
      doctorVisits:    normArr(visits),
      appointments:    normArr(appts),
      usageMetrics:    normArr(metrics),
      recentActivity:  normArr(activity),
      totalChats,
      totalMedsTaken,
      totalEmergencies,
      totalAppointments,
      totalDrQuestions,
      totalDoctorVisits,
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
    console.log(`✅ Senior login: ${senior.name} (${senior.id})`);
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
    console.log(`✅ Family login for: ${senior.name}`);
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
        trial_period_days: 7,
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
    const { data: senior } = await supabase.from("seniors").select("name, email, age, family_code, subscription_status, subscription_plan, created_at").eq("id", req.seniorId).single();
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

    // Start medication reminder cron — checks every minute
    if (VAPID_PUBLIC && VAPID_PRIVATE) {
      cron.schedule("* * * * *", checkMedicationReminders);
      console.log("   💊 Medication reminders: active (checking every minute)\n");
    } else {
      console.log("   💊 Medication reminders: disabled (VAPID keys not set)\n");
    }
  });
}

start().catch(console.error);

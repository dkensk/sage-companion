// ─────────────────────────────────────────────────────────────────────────────
// Sage Companion LLC — MVP Server
// Stack: Express + NeDB (pure-JS embedded database) + Anthropic Claude
// Run: node server.js
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const Anthropic = require("@anthropic-ai/sdk");
const Datastore = require("nedb-promises");
const multer = require("multer");
const { google } = require("googleapis");

// ── Multer (image uploads — memory only, no disk) ─────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

// ── Anthropic Client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Ensure data directory exists ──────────────────────────────────────────────
if (!fs.existsSync("./data")) fs.mkdirSync("./data");

// ── NeDB Datastores (files saved to ./data/) ──────────────────────────────────
const db = {
  seniors:          Datastore.create({ filename: "./data/seniors.db",          autoload: true }),
  medications:      Datastore.create({ filename: "./data/medications.db",      autoload: true }),
  med_log:          Datastore.create({ filename: "./data/med_log.db",          autoload: true }),
  activity:         Datastore.create({ filename: "./data/activity.db",         autoload: true }),
  alerts:           Datastore.create({ filename: "./data/alerts.db",           autoload: true }),
  conversations:    Datastore.create({ filename: "./data/conversations.db",    autoload: true }),
  doctor_questions: Datastore.create({ filename: "./data/doctor_questions.db", autoload: true }),
  doctor_visits:    Datastore.create({ filename: "./data/doctor_visits.db",    autoload: true }),
  appointments:     Datastore.create({ filename: "./data/appointments.db",     autoload: true }),
};

// ── Seed demo data if first run ───────────────────────────────────────────────
async function seedIfEmpty() {
  const existing = await db.seniors.findOne({});
  if (existing) return;

  console.log("📦 Seeding demo data...");
  const seniorId = "senior_margaret_001";

  await db.seniors.insert({
    _id: seniorId,
    name: "Margaret",
    age: 78,
    familyCode: "FAMILY123",
    conditions: ["mild cognitive impairment", "hypertension"],
    preferences: { voiceSpeed: "slow", theme: "high-contrast" },
    createdAt: new Date(),
  });

  await db.medications.insert([
    { _id: uuidv4(), seniorId, name: "Lisinopril",   dose: "10mg",  time: "8:00 AM",  withFood: true,  active: true, createdAt: new Date() },
    { _id: uuidv4(), seniorId, name: "Metformin",    dose: "500mg", time: "12:00 PM", withFood: true,  active: true, createdAt: new Date() },
    { _id: uuidv4(), seniorId, name: "Atorvastatin", dose: "20mg",  time: "9:00 PM",  withFood: false, active: true, createdAt: new Date() },
  ]);

  await db.activity.insert({
    _id: uuidv4(), seniorId,
    type: "system",
    description: "Sage Companion started",
    timestamp: new Date(),
  });

  console.log("✅ Demo data seeded. Senior: Margaret | Family code: FAMILY123");
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────────────────────
// ELDER API ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/senior/:id
app.get("/api/senior/:id", async (req, res) => {
  try {
    const senior = await db.seniors.findOne({ _id: req.params.id });
    if (!senior) return res.status(404).json({ error: "Senior not found" });
    res.json(senior);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/medications/:seniorId
app.get("/api/medications/:seniorId", async (req, res) => {
  try {
    const meds = await db.medications.find({ seniorId: req.params.seniorId, active: true });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const logs = await db.med_log.find({ seniorId: req.params.seniorId, takenAt: { $gte: todayStart } });
    const takenIds = new Set(logs.map(l => l.medicationId));
    res.json(meds.map(m => ({ ...m, takenToday: takenIds.has(m._id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/medications/:id/taken
app.post("/api/medications/:id/taken", async (req, res) => {
  try {
    const med = await db.medications.findOne({ _id: req.params.id });
    if (!med) return res.status(404).json({ error: "Medication not found" });
    await db.med_log.insert({ _id: uuidv4(), seniorId: med.seniorId, medicationId: med._id, medicationName: med.name, takenAt: new Date() });
    await db.activity.insert({ _id: uuidv4(), seniorId: med.seniorId, type: "medication_taken", description: `Took ${med.name} ${med.dose}`, timestamp: new Date() });
    res.json({ success: true, message: `${med.name} marked as taken` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/emergency
app.post("/api/emergency", async (req, res) => {
  try {
    const { seniorId, message } = req.body;
    const alert = { _id: uuidv4(), seniorId, type: "emergency", message: message || "Emergency button activated", severity: "critical", resolved: false, createdAt: new Date() };
    await db.alerts.insert(alert);
    await db.activity.insert({ _id: uuidv4(), seniorId, type: "emergency", description: "🚨 Emergency button activated", timestamp: new Date() });
    res.json({ success: true, alert });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chat — AI conversation
app.post("/api/chat", async (req, res) => {
  try {
    const { seniorId, message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    const effectiveSeniorId = seniorId || "senior_margaret_001";

    const senior = await db.seniors.findOne({ _id: effectiveSeniorId });
    const seniorName = senior ? senior.name : "Margaret";
    const conditions = senior ? senior.conditions.join(", ") : "mild cognitive impairment";

    const meds = await db.medications.find({ seniorId: effectiveSeniorId, active: true });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const logs = await db.med_log.find({ seniorId: effectiveSeniorId, takenAt: { $gte: todayStart } });
    const takenIds = new Set(logs.map(l => l.medicationId));
    const medSummary = meds.map(m =>
      `- ${m.name} ${m.dose} at ${m.time}${m.withFood ? " (with food)" : ""}: ${takenIds.has(m._id) ? "taken ✓" : "not yet taken"}`
    ).join("\n");

    const history = await db.conversations.find({ seniorId: effectiveSeniorId });
    const recentHistory = history.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10).reverse();

    const messages = [
      ...recentHistory.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const systemPrompt = `You are Sage, a warm, caring, and supportive AI companion for ${seniorName}, a ${senior?.age || 78}-year-old.

CRITICAL — VOICE RESPONSE FORMAT:
Your responses are read aloud by a voice assistant. Follow these rules strictly:
- NEVER use emojis of any kind — they will be read as "smiley face", "checkmark", etc.
- NEVER use bullet points, dashes, or lists — speak in natural flowing sentences only
- NEVER use markdown formatting (no asterisks, pound signs, brackets)
- NEVER use abbreviations that sound odd when spoken (e.g. "Dr." is fine, but avoid technical shorthand)
- Write exactly as you would speak to a kind, caring friend — warm, conversational, natural
- Keep responses to 2 to 4 sentences maximum

Your personality:
- Always kind, patient, gentle, and encouraging
- Speak simply and clearly — short sentences, no jargon
- Be a warm friend and companion, not a clinical assistant
- If ${seniorName} seems confused or upset, respond with extra calm and reassurance
- Use natural speech patterns — contractions are good ("I'm", "you're", "that's")

IMPORTANT — What you MUST NOT do:
- Never provide medical advice, diagnoses, or treatment recommendations
- Never comment on whether a medication dose is correct or safe
- Never suggest changes to medications or medical routines
- Never provide legal or financial advice
- Never make assessments about symptoms or health conditions

When ${seniorName} asks about symptoms, medications, medical concerns, or anything health-related:
1. Acknowledge their concern warmly ("That's such a good thing to think about" or "I'm glad you're paying attention to that")
2. Gently explain: "I'm not able to give medical advice, but that's really a question for your doctor."
3. End your response with this exact tag on a new line so it can be saved: [ASK_DOCTOR: <a clear question to ask their doctor>]

Example — if ${seniorName} says "My leg has been hurting, should I take more aspirin?":
"I'm sorry your leg has been hurting, that sounds uncomfortable. I'm not able to give medical advice, but your doctor would be the perfect person to ask about that. [ASK_DOCTOR: My leg has been hurting. Is it okay to take aspirin for the pain, and if so how much?]"

For true emergencies like chest pain, difficulty breathing, or a fall: Always say to call 911 or press the emergency button right away.

Today's medication status:
${medSummary || "No medications scheduled today"}

Current time: ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`;

    const response = await anthropic.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 350,
      system: systemPrompt,
      messages,
    });

    const rawReply = response.content[0].text;

    // Parse out [ASK_DOCTOR: ...] tag if present
    const askDoctorMatch = rawReply.match(/\[ASK_DOCTOR:\s*(.+?)\]/s);
    const suggestedQuestion = askDoctorMatch ? askDoctorMatch[1].trim() : null;
    const aiReply = rawReply.replace(/\[ASK_DOCTOR:\s*.+?\]/s, "").trim();

    const sid = sessionId || uuidv4();

    await db.conversations.insert({ _id: uuidv4(), seniorId: effectiveSeniorId, sessionId: sid, role: "user",      content: message,  timestamp: new Date() });
    await db.conversations.insert({ _id: uuidv4(), seniorId: effectiveSeniorId, sessionId: sid, role: "assistant", content: aiReply,  timestamp: new Date() });
    await db.activity.insert({ _id: uuidv4(), seniorId: effectiveSeniorId, type: "conversation", description: `Chat: "${message.slice(0,60)}${message.length > 60 ? "..." : ""}"`, timestamp: new Date() });

    res.json({ reply: aiReply, sessionId: sid, suggestedQuestion });
  } catch (e) {
    console.error("Chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEXT-TO-SPEECH API (ElevenLabs — natural voice)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/tts
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "ElevenLabs not configured" });

  // Voice: "Aria" — warm, natural, clear (great for senior companion)
  // You can change this to any ElevenLabs voice ID
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";

  const https = require("https");
  const payload = JSON.stringify({
    text: text.slice(0, 800),
    model_id: "eleven_turbo_v2_5",
    voice_settings: {
      stability: 0.55,
      similarity_boost: 0.80,
      style: 0.20,
      use_speaker_boost: true,
    },
  });

  const options = {
    hostname: "api.elevenlabs.io",
    path: `/v1/text-to-speech/${voiceId}`,
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  const ttsReq = https.request(options, (ttsRes) => {
    if (ttsRes.statusCode !== 200) {
      console.error("ElevenLabs error:", ttsRes.statusCode);
      return res.status(502).json({ error: "TTS service error" });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");
    ttsRes.pipe(res);
  });

  ttsReq.on("error", (e) => {
    console.error("TTS request error:", e.message);
    res.status(502).json({ error: "TTS connection error" });
  });

  ttsReq.write(payload);
  ttsReq.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// DOCTOR QUESTIONS API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/doctor-questions/:seniorId
app.get("/api/doctor-questions/:seniorId", async (req, res) => {
  try {
    const questions = await db.doctor_questions.find({ seniorId: req.params.seniorId });
    res.json(questions.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/doctor-questions
app.post("/api/doctor-questions", async (req, res) => {
  try {
    const { seniorId, question } = req.body;
    if (!seniorId || !question) return res.status(400).json({ error: "seniorId and question required" });
    const q = { _id: uuidv4(), seniorId, question: question.trim(), asked: false, createdAt: new Date() };
    await db.doctor_questions.insert(q);
    await db.activity.insert({ _id: uuidv4(), seniorId, type: "doctor_question", description: `Doctor question added: "${question.slice(0,60)}"`, timestamp: new Date() });
    res.json({ success: true, question: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/doctor-questions/:id/asked — mark as asked
app.patch("/api/doctor-questions/:id/asked", async (req, res) => {
  try {
    await db.doctor_questions.update({ _id: req.params.id }, { $set: { asked: true, askedAt: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/doctor-questions/:id
app.delete("/api/doctor-questions/:id", async (req, res) => {
  try {
    await db.doctor_questions.remove({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DOCTOR VISITS API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/doctor-visits/:seniorId
app.get("/api/doctor-visits/:seniorId", async (req, res) => {
  try {
    const visits = await db.doctor_visits.find({ seniorId: req.params.seniorId });
    res.json(visits.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/doctor-visits — save a completed transcription
app.post("/api/doctor-visits", async (req, res) => {
  try {
    const { seniorId, transcript, doctorName, notes } = req.body;
    if (!seniorId || !transcript) return res.status(400).json({ error: "seniorId and transcript required" });
    const visit = {
      _id: uuidv4(),
      seniorId,
      transcript: transcript.trim(),
      doctorName: doctorName || "",
      notes: notes || "",
      wordCount: transcript.trim().split(/\s+/).length,
      createdAt: new Date(),
    };
    await db.doctor_visits.insert(visit);
    await db.activity.insert({ _id: uuidv4(), seniorId, type: "doctor_visit", description: `Doctor visit recorded${doctorName ? " with Dr. " + doctorName : ""}`, timestamp: new Date() });
    res.json({ success: true, visit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// FAMILY API ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/senior/by-code/:code
app.get("/api/senior/by-code/:code", async (req, res) => {
  try {
    const senior = await db.seniors.findOne({ familyCode: req.params.code });
    if (!senior) return res.status(404).json({ error: "Invalid family code" });
    res.json(senior);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/:seniorId
app.get("/api/dashboard/:seniorId", async (req, res) => {
  try {
    const { seniorId } = req.params;
    const senior = await db.seniors.findOne({ _id: seniorId });
    if (!senior) return res.status(404).json({ error: "Senior not found" });

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const meds     = await db.medications.find({ seniorId, active: true });
    const logs     = await db.med_log.find({ seniorId, takenAt: { $gte: todayStart } });
    const alerts   = await db.alerts.find({ seniorId, resolved: false });
    const convos   = await db.conversations.find({ seniorId, role: "user", timestamp: { $gte: todayStart } });
    const activity = await db.activity.find({ seniorId });
    const openQuestions = await db.doctor_questions.find({ seniorId, asked: false });

    const takenToday = logs.length;
    const adherence  = meds.length > 0 ? Math.round((takenToday / meds.length) * 100) : 0;
    const recentActivity = activity.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 20);
    const lastEvent = recentActivity[0];
    const lastSeenMinutes = lastEvent ? Math.round((Date.now() - new Date(lastEvent.timestamp).getTime()) / 60000) : null;

    res.json({
      senior,
      stats: {
        medicationsTaken: takenToday,
        medicationsTotal: meds.length,
        adherence,
        activeAlerts: alerts.length,
        conversationsToday: convos.length,
        lastSeenMinutes,
        openDoctorQuestions: openQuestions.length,
      },
      alerts: alerts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10),
      recentActivity,
      medications: meds.map(m => ({ ...m, takenToday: logs.some(l => l.medicationId === m._id) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/medications — family adds medication
app.post("/api/medications", async (req, res) => {
  try {
    const { seniorId, name, dose, time, withFood } = req.body;
    if (!seniorId || !name || !dose || !time) return res.status(400).json({ error: "seniorId, name, dose, time are required" });
    const med = { _id: uuidv4(), seniorId, name, dose, time, withFood: !!withFood, active: true, createdAt: new Date() };
    await db.medications.insert(med);
    await db.activity.insert({ _id: uuidv4(), seniorId, type: "medication_added", description: `Family added: ${name} ${dose}`, timestamp: new Date() });
    res.json({ success: true, medication: med });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/medications/:id
app.delete("/api/medications/:id", async (req, res) => {
  try {
    await db.medications.update({ _id: req.params.id }, { $set: { active: false } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alerts/:id/resolve
app.post("/api/alerts/:id/resolve", async (req, res) => {
  try {
    await db.alerts.update({ _id: req.params.id }, { $set: { resolved: true, resolvedAt: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/conversations/:seniorId
app.get("/api/conversations/:seniorId", async (req, res) => {
  try {
    const rows = await db.conversations.find({ seniorId: req.params.seniorId });
    const sorted = rows.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
    const sessions = {};
    for (const row of sorted) {
      if (!sessions[row.sessionId]) sessions[row.sessionId] = [];
      sessions[row.sessionId].push(row);
    }
    const sessionList = Object.entries(sessions)
      .map(([id, msgs]) => ({ sessionId: id, messages: msgs, startedAt: msgs[0].timestamp }))
      .sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 20);
    res.json(sessionList);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/appointments/:seniorId
app.get("/api/appointments/:seniorId", async (req, res) => {
  try {
    const appts = await db.appointments.find({ seniorId: req.params.seniorId });
    const sorted = appts.sort((a,b) => new Date(a.date) - new Date(b.date));
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/appointments — save a parsed appointment
app.post("/api/appointments", async (req, res) => {
  try {
    const { seniorId, title, date, time, location, notes, source } = req.body;
    if (!seniorId || !title || !date) return res.status(400).json({ error: "seniorId, title, date required" });
    const appt = { _id: uuidv4(), seniorId, title, date, time: time||null, location: location||"", notes: notes||"", source: source||"manual", googleEventId: null, createdAt: new Date() };
    await db.appointments.insert(appt);
    await db.activity.insert({ _id: uuidv4(), seniorId, type: "appointment_added", description: `Appointment: ${title} on ${date}`, timestamp: new Date() });
    res.json({ success: true, appointment: appt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/appointments/:id
app.delete("/api/appointments/:id", async (req, res) => {
  try {
    await db.appointments.remove({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/appointments/parse — use Claude to parse natural language into structured appointment
app.post("/api/appointments/parse", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 300,
      messages: [{ role: "user", content: `Today is ${today}. Parse this appointment into JSON. Return ONLY valid JSON, nothing else.\n\nInput: "${text}"\n\nReturn a JSON object with:\n- "title": event name (string, required)\n- "date": ISO date YYYY-MM-DD (string, required — infer the year if not given)\n- "time": time string like "2:00 PM" or null\n- "location": location string or null\n- "notes": any extra details or null` }],
    });
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(400).json({ error: "Could not parse appointment" });
    res.json(JSON.parse(match[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/appointments/ocr — Claude Vision reads a photo of a paper calendar
app.post("/api/appointments/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image provided" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype;
    const today = new Date().toLocaleDateString("en-US", { year:"numeric", month:"long" });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 1500,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: `This is a photo of a paper calendar. Today's month/year context: ${today}.\n\nExtract every appointment, event, or note you can see written on it.\nReturn ONLY a JSON array, no other text:\n[\n  { "title": "event name", "date": "YYYY-MM-DD", "time": "2:00 PM or null", "notes": "extra detail or null" }\n]\nFor dates, infer the year from context. Include every handwritten or printed event you can read.` }
      ]}],
    });
    const match = response.content[0].text.match(/\[[\s\S]*\]/);
    res.json({ events: match ? JSON.parse(match[0]) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/calendar/:seniorId/feed.ics — Apple Calendar webcal subscription feed
app.get("/api/calendar/:seniorId/feed.ics", async (req, res) => {
  try {
    const { seniorId } = req.params;
    const senior = await db.seniors.findOne({ _id: seniorId });
    const appts = await db.appointments.find({ seniorId });
    const fmt = (d) => d.toISOString().replace(/[-:.]/g, "").slice(0,15) + "Z";
    const lines = appts.map(a => {
      const start = new Date(a.date + (a.time ? " " + a.time : " 00:00"));
      const end   = new Date(start.getTime() + 60 * 60 * 1000);
      return [
        "BEGIN:VEVENT",
        `UID:${a._id}@sage-companion`,
        `DTSTAMP:${fmt(new Date())}`,
        `DTSTART:${fmt(start)}`,
        `DTEND:${fmt(end)}`,
        `SUMMARY:${a.title}`,
        a.location ? `LOCATION:${a.location}` : "",
        a.notes    ? `DESCRIPTION:${a.notes}`   : "",
        "END:VEVENT",
      ].filter(Boolean).join("\r\n");
    });
    const cal = [
      "BEGIN:VCALENDAR","VERSION:2.0",
      "PRODID:-//Sage Companion LLC//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",
      `X-WR-CALNAME:Sage Companion — ${senior?.name || "Calendar"}`,
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      ...lines,
      "END:VCALENDAR",
    ].join("\r\n");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sage-companion.ics"`);
    res.send(cal);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Google Calendar OAuth ─────────────────────────────────────────────────────
function getGoogleClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/google/callback"
  );
}

// GET /api/google/auth?seniorId=xxx — start OAuth flow
app.get("/api/google/auth", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send("Google Calendar not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env");
  const client = getGoogleClient();
  const url = client.generateAuthUrl({
    access_type: "offline", prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: req.query.seniorId || "senior_margaret_001",
  });
  res.redirect(url);
});

// GET /api/google/callback — OAuth callback
app.get("/api/google/callback", async (req, res) => {
  try {
    const { code, state: seniorId } = req.query;
    const client = getGoogleClient();
    const { tokens } = await client.getToken(code);
    await db.seniors.update({ _id: seniorId }, { $set: { googleTokens: tokens } });
    res.redirect(`/calendar?google=connected&seniorId=${seniorId}`);
  } catch (e) { res.status(500).send("Google auth failed: " + e.message); }
});

// GET /api/google/status/:seniorId
app.get("/api/google/status/:seniorId", async (req, res) => {
  try {
    const senior = await db.seniors.findOne({ _id: req.params.seniorId });
    res.json({ connected: !!(senior?.googleTokens), configured: !!process.env.GOOGLE_CLIENT_ID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google/sync/:seniorId — two-way sync
app.post("/api/google/sync/:seniorId", async (req, res) => {
  try {
    const { seniorId } = req.params;
    const senior = await db.seniors.findOne({ _id: seniorId });
    if (!senior?.googleTokens) return res.status(401).json({ error: "Google not connected" });

    const client = getGoogleClient();
    client.setCredentials(senior.googleTokens);
    // Refresh token if expired
    client.on("tokens", async (tokens) => {
      await db.seniors.update({ _id: seniorId }, { $set: { googleTokens: { ...senior.googleTokens, ...tokens } } });
    });

    const cal = google.calendar({ version: "v3", auth: client });
    const now = new Date();
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    // Pull from Google → our DB
    const gRes = await cal.events.list({
      calendarId: "primary", singleEvents: true, orderBy: "startTime",
      timeMin: now.toISOString(), timeMax: future.toISOString(), maxResults: 100,
    });
    let pulled = 0;
    for (const ev of (gRes.data.items || [])) {
      if (!ev.summary) continue;
      const startRaw = ev.start.dateTime || ev.start.date;
      const startDate = new Date(startRaw);
      const dateStr = startDate.toISOString().split("T")[0];
      const timeStr = ev.start.dateTime
        ? startDate.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })
        : null;
      const existing = await db.appointments.findOne({ googleEventId: ev.id, seniorId });
      if (existing) {
        await db.appointments.update({ _id: existing._id }, { $set: { title: ev.summary, date: dateStr, time: timeStr, location: ev.location||"", notes: ev.description||"" } });
      } else {
        await db.appointments.insert({ _id: uuidv4(), seniorId, title: ev.summary, date: dateStr, time: timeStr, location: ev.location||"", notes: ev.description||"", source: "google", googleEventId: ev.id, createdAt: new Date() });
        pulled++;
      }
    }

    // Push local appointments → Google (those without a googleEventId)
    const local = await db.appointments.find({ seniorId, googleEventId: null });
    let pushed = 0;
    for (const appt of local) {
      try {
        const startDT = new Date(appt.date + (appt.time ? " " + appt.time : "T09:00:00"));
        const endDT   = new Date(startDT.getTime() + 60 * 60 * 1000);
        const event = {
          summary: appt.title,
          location: appt.location || "",
          description: appt.notes || "",
          start: appt.time ? { dateTime: startDT.toISOString() } : { date: appt.date },
          end:   appt.time ? { dateTime: endDT.toISOString()   } : { date: appt.date },
        };
        const created = await cal.events.insert({ calendarId: "primary", resource: event });
        await db.appointments.update({ _id: appt._id }, { $set: { googleEventId: created.data.id } });
        pushed++;
      } catch(e) { /* skip individual failures */ }
    }

    await db.activity.insert({ _id: uuidv4(), seniorId, type: "calendar_sync", description: `Google Calendar synced: ${pulled} pulled, ${pushed} pushed`, timestamp: new Date() });
    const all = await db.appointments.find({ seniorId });
    res.json({ success: true, pulled, pushed, appointments: all.sort((a,b) => new Date(a.date) - new Date(b.date)) });
  } catch (e) {
    console.error("Google sync error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get("/elder",    (req, res) => res.sendFile(path.join(__dirname, "public", "elder.html")));
app.get("/family",   (req, res) => res.sendFile(path.join(__dirname, "public", "family.html")));
app.get("/doctor",   (req, res) => res.sendFile(path.join(__dirname, "public", "doctor.html")));
app.get("/calendar", (req, res) => res.sendFile(path.join(__dirname, "public", "calendar.html")));
app.get("/",         (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  await seedIfEmpty();
  app.listen(PORT, () => {
    console.log("\n🌿  Sage Companion LLC is running!\n");
    console.log(`   🌐 Open in browser: http://localhost:${PORT}`);
    console.log(`   👵 Senior view:     http://localhost:${PORT}/elder`);
    console.log(`   👨‍👩‍👧 Family view:    http://localhost:${PORT}/family`);
    console.log(`   🩺 Doctor visit:    http://localhost:${PORT}/doctor`);
    console.log(`\n   Demo family code: FAMILY123`);
    console.log("\n   Press Ctrl+C to stop\n");
  });
}

start().catch(console.error);

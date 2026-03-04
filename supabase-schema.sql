-- ─────────────────────────────────────────────────────────────────────────────
-- Sage Companion LLC — Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Seniors (user profiles) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seniors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT,
  age           INTEGER,
  family_code   TEXT UNIQUE NOT NULL,
  conditions    TEXT[]   DEFAULT '{}',
  google_tokens       JSONB,
  preferences         JSONB    DEFAULT '{"voiceSpeed":"normal","theme":"default"}',
  stripe_customer_id  TEXT,
  subscription_status TEXT     DEFAULT 'none',
  subscription_plan   TEXT     DEFAULT 'none',
  trial_ends_at       TIMESTAMPTZ,
  timezone            TEXT,
  reset_token         TEXT,
  reset_expires       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  last_active         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Medications ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id  UUID REFERENCES seniors(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  dose       TEXT,
  time       TEXT,
  med_times  TEXT,
  frequency  INTEGER DEFAULT 1,
  with_food  BOOLEAN DEFAULT FALSE,
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Medication log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS med_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id       UUID REFERENCES seniors(id) ON DELETE CASCADE,
  medication_id   UUID REFERENCES medications(id),
  medication_name TEXT,
  dose_time       TEXT,
  taken_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Activity feed ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id   UUID REFERENCES seniors(id) ON DELETE CASCADE,
  type        TEXT,
  description TEXT,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Alerts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id   UUID REFERENCES seniors(id) ON DELETE CASCADE,
  type        TEXT,
  message     TEXT,
  severity    TEXT,
  resolved    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- ── Conversations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id  UUID REFERENCES seniors(id) ON DELETE CASCADE,
  session_id TEXT,
  role       TEXT,
  content    TEXT,
  timestamp  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Doctor questions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_questions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id  UUID REFERENCES seniors(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  asked      BOOLEAN DEFAULT FALSE,
  asked_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Doctor visits ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id   UUID REFERENCES seniors(id) ON DELETE CASCADE,
  transcript  TEXT,
  doctor_name TEXT    DEFAULT '',
  notes       TEXT    DEFAULT '',
  word_count  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Appointments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id       UUID REFERENCES seniors(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  date            DATE,
  time            TEXT,
  location        TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  source          TEXT DEFAULT 'manual',
  google_event_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Usage metrics (daily rollup per senior — powers CRM analytics) ────────────
CREATE TABLE IF NOT EXISTS usage_metrics (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id               UUID REFERENCES seniors(id) ON DELETE CASCADE,
  date                    DATE DEFAULT CURRENT_DATE,
  chat_messages           INTEGER DEFAULT 0,
  medications_taken       INTEGER DEFAULT 0,
  doctor_questions_added  INTEGER DEFAULT 0,
  appointments_added      INTEGER DEFAULT 0,
  emergency_alerts        INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(senior_id, date)
);

-- ── Indexes for performance ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_medications_senior      ON medications(senior_id);
CREATE INDEX IF NOT EXISTS idx_med_log_senior          ON med_log(senior_id);
CREATE INDEX IF NOT EXISTS idx_med_log_taken_at        ON med_log(taken_at);
CREATE INDEX IF NOT EXISTS idx_activity_senior         ON activity(senior_id);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp      ON activity(timestamp);
CREATE INDEX IF NOT EXISTS idx_alerts_senior           ON alerts(senior_id);
CREATE INDEX IF NOT EXISTS idx_conversations_senior    ON conversations(senior_id);
CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_doctor_questions_senior ON doctor_questions(senior_id);
CREATE INDEX IF NOT EXISTS idx_doctor_visits_senior    ON doctor_visits(senior_id);
CREATE INDEX IF NOT EXISTS idx_appointments_senior     ON appointments(senior_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date       ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_usage_senior            ON usage_metrics(senior_id);
CREATE INDEX IF NOT EXISTS idx_usage_date              ON usage_metrics(date);
CREATE INDEX IF NOT EXISTS idx_seniors_last_active     ON seniors(last_active);

-- ── Atomic usage counter increment (called from server) ───────────────────────
CREATE OR REPLACE FUNCTION increment_usage(p_senior_id UUID, p_date DATE, p_field TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO usage_metrics (senior_id, date)
  VALUES (p_senior_id, p_date)
  ON CONFLICT (senior_id, date) DO NOTHING;

  EXECUTE format(
    'UPDATE usage_metrics SET %I = COALESCE(%I, 0) + 1 WHERE senior_id = $1 AND date = $2',
    p_field, p_field
  ) USING p_senior_id, p_date;
END;
$$ LANGUAGE plpgsql;

-- ── Demo senior (Margaret) — family code: FAMILY123 ───────────────────────────
INSERT INTO seniors (id, name, age, family_code, conditions, preferences, last_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Margaret', 78, 'FAMILY123',
  ARRAY['mild cognitive impairment', 'hypertension'],
  '{"voiceSpeed":"slow","theme":"high-contrast"}',
  NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO medications (senior_id, name, dose, time, with_food, active)
SELECT '00000000-0000-0000-0000-000000000001', name, dose, time, with_food, true
FROM (VALUES
  ('Lisinopril',   '10mg',  '8:00 AM',  true),
  ('Metformin',    '500mg', '12:00 PM', true),
  ('Atorvastatin', '20mg',  '9:00 PM',  false)
) AS v(name, dose, time, with_food)
WHERE NOT EXISTS (
  SELECT 1 FROM medications WHERE senior_id = '00000000-0000-0000-0000-000000000001'
);

-- ── Push Subscriptions (medication reminder notifications) ────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id        UUID NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
  subscription_json TEXT NOT NULL,
  device_label     TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_used        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_senior ON push_subscriptions(senior_id);

-- ── Reminder Snooze Log (track snoozed reminders to avoid re-sending) ─────────
CREATE TABLE IF NOT EXISTS reminder_snooze (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id     UUID NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
  medication_id UUID NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  snoozed_until TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminder_snooze_senior ON reminder_snooze(senior_id);

-- ── Senior Tokens (session audit trail) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS senior_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id  UUID NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  issued_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN DEFAULT FALSE,
  device     TEXT DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_senior_tokens_senior ON senior_tokens(senior_id);
CREATE INDEX IF NOT EXISTS idx_senior_tokens_hash   ON senior_tokens(token_hash);

-- ── Reminders / To-Do Items ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id   UUID NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  due_date    DATE,
  due_time    TEXT,
  completed   BOOLEAN DEFAULT FALSE,
  source      TEXT DEFAULT 'manual',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_senior ON reminders(senior_id, completed);

-- ── Migration: Multi-dose medication support ────────────────────────────────
-- Run these if upgrading an existing database:
ALTER TABLE medications ADD COLUMN IF NOT EXISTS med_times TEXT;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS frequency INTEGER DEFAULT 1;
ALTER TABLE med_log ADD COLUMN IF NOT EXISTS dose_time TEXT;
ALTER TABLE seniors ADD COLUMN IF NOT EXISTS timezone TEXT;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Enable RLS on all tables (service_role key bypasses RLS, so your server
-- continues to work. This blocks direct access via the anon/public key.)
ALTER TABLE seniors ENABLE ROW LEVEL SECURITY;
ALTER TABLE medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE med_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_snooze ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

-- Restrictive policies: deny all access via anon/authenticated keys
DROP POLICY IF EXISTS "Service role full access" ON seniors;
DROP POLICY IF EXISTS "Service role full access" ON medications;
DROP POLICY IF EXISTS "Service role full access" ON med_log;
DROP POLICY IF EXISTS "Service role full access" ON activity;
DROP POLICY IF EXISTS "Service role full access" ON alerts;
DROP POLICY IF EXISTS "Service role full access" ON conversations;
DROP POLICY IF EXISTS "Service role full access" ON doctor_questions;
DROP POLICY IF EXISTS "Service role full access" ON doctor_visits;
DROP POLICY IF EXISTS "Service role full access" ON appointments;
DROP POLICY IF EXISTS "Service role full access" ON usage_metrics;
DROP POLICY IF EXISTS "Service role full access" ON push_subscriptions;
DROP POLICY IF EXISTS "Service role full access" ON reminder_snooze;
DROP POLICY IF EXISTS "Service role full access" ON reminders;

DROP POLICY IF EXISTS "Deny public access" ON seniors;
DROP POLICY IF EXISTS "Deny public access" ON medications;
DROP POLICY IF EXISTS "Deny public access" ON med_log;
DROP POLICY IF EXISTS "Deny public access" ON activity;
DROP POLICY IF EXISTS "Deny public access" ON alerts;
DROP POLICY IF EXISTS "Deny public access" ON conversations;
DROP POLICY IF EXISTS "Deny public access" ON doctor_questions;
DROP POLICY IF EXISTS "Deny public access" ON doctor_visits;
DROP POLICY IF EXISTS "Deny public access" ON appointments;
DROP POLICY IF EXISTS "Deny public access" ON usage_metrics;
DROP POLICY IF EXISTS "Deny public access" ON push_subscriptions;
DROP POLICY IF EXISTS "Deny public access" ON reminder_snooze;
DROP POLICY IF EXISTS "Deny public access" ON reminders;

CREATE POLICY "Deny public access" ON seniors FOR ALL USING (false);
CREATE POLICY "Deny public access" ON medications FOR ALL USING (false);
CREATE POLICY "Deny public access" ON med_log FOR ALL USING (false);
CREATE POLICY "Deny public access" ON activity FOR ALL USING (false);
CREATE POLICY "Deny public access" ON alerts FOR ALL USING (false);
CREATE POLICY "Deny public access" ON conversations FOR ALL USING (false);
CREATE POLICY "Deny public access" ON doctor_questions FOR ALL USING (false);
CREATE POLICY "Deny public access" ON doctor_visits FOR ALL USING (false);
CREATE POLICY "Deny public access" ON appointments FOR ALL USING (false);
CREATE POLICY "Deny public access" ON usage_metrics FOR ALL USING (false);
CREATE POLICY "Deny public access" ON push_subscriptions FOR ALL USING (false);
CREATE POLICY "Deny public access" ON reminder_snooze FOR ALL USING (false);
CREATE POLICY "Deny public access" ON reminders FOR ALL USING (false);

-- Fix function search path warning
ALTER FUNCTION increment_usage(UUID, DATE, TEXT) SET search_path = public;

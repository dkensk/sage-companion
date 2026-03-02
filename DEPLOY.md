# Sage Companion — Deployment Guide

This guide covers everything you need to go from local development to a live production URL.

---

## Step 1: Set Up Supabase (your database)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Click **New Project** — name it `sage-companion`, choose a region close to you, set a database password
3. Once created, go to **SQL Editor → New query**
4. Paste the entire contents of `supabase-schema.sql` and click **Run**
5. Go to **Project Settings → API** and copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role** key (under "Project API keys") → this is your `SUPABASE_SERVICE_ROLE_KEY`
   - ⚠️ Use `service_role`, NOT the `anon` key

---

## Step 2: Deploy to Render

1. Go to [render.com](https://render.com) and sign up
2. Click **New → Web Service**
3. Connect your GitHub repo `dkensk/sage-companion`
4. Render auto-detects the settings from `render.yaml`
5. Add the environment variables listed below
6. Click **Create Web Service**

### Environment Variables

Set these in your Render dashboard → **Environment** tab:

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `FRONTEND_URL` | `https://mysagecompanion.com` (your domain) |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `OPENAI_API_KEY` | Your OpenAI key (for TTS voice) |
| `SUPABASE_URL` | From Step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | From Step 1 |
| `ADMIN_PASSWORD` | A strong password (not `admin123`) |
| `JWT_SECRET` | A long random string (not the dev default) |
| `SENIOR_TOKEN_SECRET` | A long random string (not the dev default) |
| `VAPID_PUBLIC_KEY` | From your .env |
| `VAPID_PRIVATE_KEY` | From your .env |
| `VAPID_EMAIL` | `mailto:your@email.com` |
| `GOOGLE_CLIENT_ID` | Optional — for Google Calendar sync |
| `GOOGLE_CLIENT_SECRET` | Optional |
| `GOOGLE_REDIRECT_URI` | `https://mysagecompanion.com/api/google/callback` |
| `STRIPE_SECRET_KEY` | Your Stripe live key |
| `STRIPE_WEBHOOK_SECRET` | From Stripe webhook setup |
| `STRIPE_PRICE_ID` | Your Stripe live price ID |

Your app will be live at your Render URL or custom domain.

---

## Step 3: Set Up Push Notifications (for medication reminders)

The VAPID keys are already generated and in your `.env` file. Just make sure these 3 are set in Render:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_EMAIL` (format: `mailto:you@youremail.com`)

Seniors will see an "Enable Reminders" button in the app — when they tap it, their device registers for push notifications.

---

## Step 4: Test your live deployment

1. Visit `https://your-app-url/` — you should see the Sage home screen
2. Visit `https://your-app-url/admin` — log in with your `ADMIN_PASSWORD`
3. Tap **Get Started** and create a test profile to verify Supabase is connected
4. Try talking to Sage to verify Anthropic + OpenAI TTS are working

---

## Custom Domain

Render supports custom domains for free:
- Service Settings → Custom Domains
- Point your domain's CNAME to the provided value and SSL is automatic

---

## Updating the app

Every time you push to GitHub (`git push`), Render auto-deploys within ~2 minutes.

```bash
git add .
git commit -m "your update message"
git push
```

---

## Local development

```bash
cd "Guardian AI/guardian-mvp"
npm install
# Make sure .env has all values filled in
npm start
# Open http://localhost:3000
```

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

## Step 2: Deploy to Railway (Recommended — Free)

Railway is the fastest way to deploy — it connects to your GitHub repo and auto-deploys on every push.

### 2a. First push your code to GitHub
```bash
cd "Guardian AI/guardian-mvp"
git push
```

### 2b. Create Railway project
1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select `dkensk/sage-companion`
4. Railway will detect the Node.js app and deploy automatically

### 2c. Set environment variables in Railway
In your Railway project → **Variables** tab, add each of these:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic key (from .env) |
| `OPENAI_API_KEY` | Your OpenAI key (for TTS voice) |
| `SUPABASE_URL` | From Step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | From Step 1 |
| `ADMIN_PASSWORD` | Choose a strong password |
| `JWT_SECRET` | Any long random string (e.g. `sage-prod-secret-2024-xk9p`) |
| `VAPID_PUBLIC_KEY` | From your .env |
| `VAPID_PRIVATE_KEY` | From your .env |
| `VAPID_EMAIL` | `mailto:your@email.com` |
| `GOOGLE_CLIENT_ID` | Optional — for Google Calendar sync |
| `GOOGLE_CLIENT_SECRET` | Optional |

### 2d. Get your URL
After deploy, Railway gives you a URL like `https://sage-companion-production.up.railway.app`

Update `GOOGLE_REDIRECT_URI` in Railway variables to:
`https://your-railway-url.up.railway.app/api/google/callback`

---

## Step 3: Deploy to Render (Alternative — Also Free)

1. Go to [render.com](https://render.com) and sign up
2. Click **New → Web Service**
3. Connect your GitHub repo `dkensk/sage-companion`
4. Render auto-detects the settings from `render.yaml`
5. Add the same environment variables as listed in Step 2c
6. Click **Create Web Service**

Your app will be live at `https://sage-companion.onrender.com`

> **Note:** Render free tier spins down after 15 mins of inactivity (cold start ~30s). Railway free tier stays warm longer.

---

## Step 4: Set Up Push Notifications (for medication reminders)

The VAPID keys are already generated and in your `.env` file. Just make sure these 3 are set in your deployment platform:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_EMAIL` (format: `mailto:you@youremail.com`)

Seniors will see an "Enable Reminders" button in the app — when they tap it, their device registers for push notifications.

---

## Step 5: Test your live deployment

1. Visit `https://your-app-url/` — you should see the Sage home screen
2. Visit `https://your-app-url/admin` — log in with your `ADMIN_PASSWORD`
3. Tap **Get Started** and create a test profile to verify Supabase is connected
4. Try talking to Sage to verify Anthropic + OpenAI TTS are working

---

## Custom Domain (optional)

Both Railway and Render support custom domains for free:
- Railway: Project Settings → Domains → Add custom domain
- Render: Service Settings → Custom Domains

Point your domain's CNAME to the provided value and SSL is automatic.

---

## Updating the app

Every time you push to GitHub (`git push`), Railway/Render auto-deploys within ~2 minutes. No manual steps needed.

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

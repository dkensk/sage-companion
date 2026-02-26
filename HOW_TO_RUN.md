# 🌿 Sage Companion LLC — How to Run on Your Mac

This takes about 5 minutes. You'll do it once, then starting Sage Companion takes one click.

---

## STEP 1 — Install Node.js (one time only)

1. Open your browser and go to: **https://nodejs.org**
2. Click the big green button that says **"LTS"** (it's the recommended version)
3. The download starts automatically — open the file when it's done
4. Click through the installer (Next → Next → Install → Close)
5. Done! You only need to do this once.

**To check it worked:** Open Terminal (press ⌘ Space, type "Terminal", press Enter) and type:
```
node --version
```
You should see something like `v20.11.0`. Any number is fine.

---

## STEP 2 — Add Your Anthropic API Key

1. In Finder, open the **Guardian AI** folder
2. Open the **guardian-mvp** folder inside it
3. Find the file called **`.env`** — if you don't see it, press ⌘ Shift . (period) to show hidden files
4. Open `.env` with TextEdit (right-click → Open With → TextEdit)
5. You'll see this line:
   ```
   ANTHROPIC_API_KEY=your-key-here
   ```
6. Replace `your-key-here` with your actual API key (the one that starts with `sk-ant-...`)
7. Save and close the file

**Your API key looks like:** `sk-ant-api03-...` (a long string of letters and numbers)

---

## STEP 3 — Install the App (one time only)

1. Open Terminal (⌘ Space → "Terminal" → Enter)
2. Type this command and press Enter:
   ```
   cd ~/Desktop
   ```
   (If your Guardian AI folder is somewhere else, adjust accordingly)
3. Then type:
   ```
   cd "Guardian AI/guardian-mvp"
   ```
4. Then type:
   ```
   npm install
   ```
5. Wait about 30 seconds for it to finish. You'll see text scrolling — that's normal.

---

## STEP 4 — Start Sage Companion! 🚀

Every time you want to run Sage Companion, do this:

1. Open Terminal
2. Type:
   ```
   cd "Guardian AI/guardian-mvp"
   ```
3. Type:
   ```
   node server.js
   ```
4. You'll see:
   ```
   🌿  Sage Companion LLC is running!
      🌐 Open in browser: http://localhost:3000
   ```
5. Open your browser and go to: **http://localhost:3000**

That's it! Sage Companion is running on your Mac.

---

## Using Sage Companion

### For the Senior (Margaret in the demo):
- Go to **http://localhost:3000/elder**
- Tap the big microphone button to talk to Sage
- The "HELP" button at the bottom is the emergency button
- Tap "My Pills" to see and mark medications as taken

### For the Family Dashboard:
- Go to **http://localhost:3000/family**
- Enter the family code: **FAMILY123**
- See Margaret's activity, medications, and any alerts
- Add or manage medications from the dashboard

---

## To Stop the App

In Terminal, press **Control + C** (hold Control, press C).

---

## Shortcut — Make a Start Script

Want to start Sage Companion with a double-click? Create this file:

1. Open TextEdit
2. Go to Format → Make Plain Text
3. Paste this:
   ```
   #!/bin/bash
   cd "$(dirname "$0")"
   node server.js
   ```
4. Save it as **`start.command`** inside the `guardian-mvp` folder
5. In Terminal, run: `chmod +x ~/path-to/guardian-mvp/start.command`
6. Now you can double-click `start.command` to start the app!

---

## Troubleshooting

**"command not found: node"**
→ Node.js isn't installed yet. Go back to Step 1.

**"Error: ANTHROPIC_API_KEY is required"**
→ Your API key isn't in the `.env` file yet. Go back to Step 2.

**"Port 3000 already in use"**
→ Sage Companion is already running. Open http://localhost:3000 in your browser.

**The page won't load**
→ Make sure Terminal is still open and `node server.js` is running. Don't close Terminal while using Sage Companion.

---

*Sage Companion LLC · Built with care · Powered by Anthropic Claude*

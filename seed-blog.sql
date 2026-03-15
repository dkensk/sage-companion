-- Run this in Supabase SQL Editor to create the blog_posts table and seed initial articles
-- First, create the table (safe to re-run)
CREATE TABLE IF NOT EXISTS blog_posts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  excerpt     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'general',
  emoji       TEXT DEFAULT '📝',
  color_from  TEXT DEFAULT '#1E3A8A',
  color_to    TEXT DEFAULT '#2D4EAA',
  published   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug      ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON blog_posts(published, created_at DESC);

-- Seed the 6 starter blog posts
INSERT INTO blog_posts (slug, title, excerpt, content, category, emoji, color_from, color_to, published, created_at) VALUES

('medication-reminders-for-seniors',
 'Why Medication Reminders Matter More Than You Think',
 'Nearly 50% of seniors don''t take medications as prescribed. Here''s how gentle, consistent reminders can dramatically improve health outcomes and reduce hospital visits.',
 '<h2>The Hidden Cost of Missed Medications</h2>
<p>According to the CDC, medication non-adherence causes approximately 125,000 deaths and 10% of all hospitalizations in the United States each year. For seniors managing multiple prescriptions, the challenge of remembering the right dose at the right time is very real — and the consequences can be serious.</p>

<p>It''s not about forgetfulness or carelessness. Many seniors manage complex regimens of 5 or more daily medications, each with different timing, food requirements, and refill schedules. Even the most organized person can struggle.</p>

<h2>Why Traditional Reminders Fall Short</h2>
<p>Pill organizers help, but they''re passive — they don''t actively remind you. Phone alarms work but feel impersonal and are easy to dismiss. Family members calling every day to check creates stress on both sides and can feel intrusive.</p>

<p>What seniors really need is a gentle, consistent reminder that feels caring rather than nagging — something that acknowledges them as capable adults while providing just the right amount of support.</p>

<h2>How Sage Companion Approaches Medication Reminders</h2>
<p>Sage takes a conversational approach to medication management. Instead of a harsh alarm, seniors receive a friendly voice check-in: "Good morning, Margaret! It''s time for your Lisinopril. Would you like me to remind you again in a few minutes?"</p>

<p>When they confirm they''ve taken their medication, Sage logs it automatically and notifies family members through the dashboard. If a dose is missed, family gets a gentle alert — not a panic button, just information to help them help their loved one.</p>

<h2>The Results Speak for Themselves</h2>
<p>Studies show that consistent, personalized reminders can improve medication adherence by up to 30%. When combined with family visibility and a supportive tone, the improvement is even greater.</p>

<p>The key insight is that medication management isn''t just a logistics problem — it''s a human connection problem. When seniors feel supported rather than monitored, they''re more likely to stay on track.</p>

<h2>Getting Started</h2>
<p>Setting up medication reminders with Sage takes less than two minutes. You can add medications by voice, by scanning a prescription label, or by having a family member enter them through the dashboard. Sage handles the rest — timing, tracking, and keeping everyone informed.</p>

<p>Because the best reminder is one that actually works.</p>',
 'health', '💊', '#1E3A8A', '#2D4EAA', true, '2026-03-10T12:00:00Z'),

('ai-companions-for-elderly',
 'How AI Companions Are Changing Elder Care',
 'Artificial intelligence isn''t just for tech companies. Learn how conversational AI is helping seniors stay independent, connected, and healthier than ever.',
 '<h2>Beyond the Buzzword</h2>
<p>When most people hear "artificial intelligence," they think of self-driving cars or chatbots that can''t understand simple questions. But a quieter revolution is happening in elder care — and it''s changing lives in ways that matter.</p>

<p>AI companions for seniors aren''t trying to replace human connection. They''re filling the gaps between family visits, doctor appointments, and the quiet hours that can feel isolating for someone living alone.</p>

<h2>What Makes AI Companions Different</h2>
<p>Unlike generic voice assistants, AI companions designed for seniors prioritize patience, warmth, and simplicity. They don''t require technical knowledge. They remember preferences and past conversations. And most importantly, they''re always available — at 3 AM when sleep won''t come, or at 7 AM when the morning feels long.</p>

<p>Sage Companion, for example, uses conversational AI that adapts to each senior''s communication style. Some users prefer short, direct interactions. Others enjoy longer conversations about their day, their memories, or their concerns. Sage meets them where they are.</p>

<h2>Real Benefits, Measured Results</h2>
<p>Research from MIT''s AgeLab and Stanford''s Center on Longevity has shown that regular social interaction — even with AI — can reduce feelings of loneliness by up to 40%. When combined with practical features like medication reminders and doctor visit support, AI companions become genuinely useful tools rather than novelties.</p>

<p>Family caregivers benefit too. The constant worry of "Is Mom okay?" is exhausting. AI companions that provide real-time updates through a family dashboard can significantly reduce caregiver stress and burnout.</p>

<h2>Privacy and Trust</h2>
<p>Any technology that enters a senior''s home must earn trust. That means transparent data practices, clear privacy policies, and absolute respect for the user''s autonomy. The best AI companions are designed with privacy as a foundation, not an afterthought.</p>

<p>At Sage Companion, conversations are never sold or shared with third parties. Health information is encrypted and only accessible to the senior and their designated family members.</p>

<h2>The Future Is Caring</h2>
<p>AI in elder care isn''t about replacing the human touch. It''s about extending it — making sure no senior goes an entire day without a friendly interaction, a helpful reminder, or the knowledge that someone is looking out for them.</p>

<p>That''s not the future. That''s today.</p>',
 'technology', '🤖', '#0F766E', '#14B8A6', true, '2026-03-05T12:00:00Z'),

('long-distance-caregiving-tips',
 '5 Tips for Long-Distance Caregiving',
 'Caring for a parent from miles away comes with unique challenges. These practical strategies help you stay involved and informed — no matter the distance.',
 '<h2>The Distance Dilemma</h2>
<p>An estimated 15% of family caregivers in the United States provide care from a long distance — typically defined as an hour or more from their loved one. The guilt, the worry, and the logistical challenges are real. But distance doesn''t have to mean disconnect.</p>

<p>Here are five strategies that long-distance caregivers are using to stay connected and effective.</p>

<h2>1. Establish a Daily Check-In Routine</h2>
<p>Consistency is more important than frequency. A five-minute morning call at the same time every day provides more comfort than sporadic hour-long conversations. It becomes a rhythm your parent can count on.</p>

<p>Even better: use technology that provides check-ins automatically. AI companions like Sage can have a morning conversation with your parent and share a summary with you — so you know how they''re doing even before you call.</p>

<h2>2. Build a Local Support Network</h2>
<p>You can''t be there in person, but someone can. Identify neighbors, friends from church or community groups, and local professionals who can be your eyes and ears. Exchange phone numbers, establish relationships, and don''t be afraid to ask for help.</p>

<p>Many communities also have Area Agencies on Aging that can connect you with local resources like meal delivery, transportation, and wellness checks.</p>

<h2>3. Organize Medical Information Centrally</h2>
<p>Keep a shared document or app with all medical information: medications and dosages, doctor contact information, insurance details, pharmacy information, and upcoming appointments. Make sure your parent, local contacts, and any caregiving siblings all have access.</p>

<p>Tools like Sage Companion''s family dashboard keep this information updated in real-time, so you''re never working with outdated data.</p>

<h2>4. Automate What You Can</h2>
<p>Medication reminders, appointment notifications, refill alerts, and daily check-ins can all be automated without losing the personal touch. This frees up your actual conversations for what matters — connection, not logistics.</p>

<p>Automation isn''t cold. When done right, it''s the scaffolding that supports genuine human relationships by removing the burden of constant coordination.</p>

<h2>5. Take Care of Yourself</h2>
<p>Caregiver burnout doesn''t require physical proximity. The mental load of long-distance caregiving — the worry, the guilt, the decision fatigue — is real and draining. Join a support group (many meet online now), set boundaries with yourself, and recognize that you''re doing the best you can.</p>

<p>You can''t pour from an empty cup, even from 500 miles away.</p>',
 'family', '👨‍👩‍👧', '#92400E', '#D97706', true, '2026-02-28T12:00:00Z'),

('keeping-doctors-appointments-organized',
 'Never Lose Track of a Doctor Visit Again',
 'Between specialists, follow-ups, and test results, it''s easy to lose track. Here''s how to keep every appointment organized and accessible for the whole family.',
 '<h2>The Appointment Avalanche</h2>
<p>The average senior sees 4 to 7 different healthcare providers per year. Add in follow-ups, lab work, specialist referrals, and annual screenings, and it''s easy to understand how appointments slip through the cracks.</p>

<p>Missed appointments aren''t just inconvenient — they can delay diagnoses, waste specialist availability, and create gaps in care that compound over time.</p>

<h2>The Information Problem</h2>
<p>Even when appointments happen, the information from them often doesn''t flow well. Your parent leaves the doctor''s office with verbal instructions that are half-forgotten by the time they reach the car. Important follow-up tasks get lost. Medication changes aren''t communicated to family members who help manage care.</p>

<p>This isn''t anyone''s fault. It''s a systems problem — and it has solutions.</p>

<h2>Record Everything</h2>
<p>One of the most impactful changes you can make is to record doctor visits (with permission). Many practices allow this, and the resulting transcript is invaluable for reviewing instructions, catching details that were missed, and sharing information with family members who couldn''t attend.</p>

<p>Sage Companion includes a doctor visit recorder that captures the conversation and generates a summary with key action items — making it easy for the whole family to stay informed.</p>

<h2>Use a Shared Calendar</h2>
<p>A shared digital calendar that syncs across family members eliminates the "I didn''t know about that appointment" problem. Google Calendar, Apple Calendar, or dedicated care coordination apps all work well.</p>

<p>The key is choosing a system that your parent can also see and understand. Voice-activated calendar management ("Sage, when is my next doctor appointment?") removes the barrier of navigating apps and screens.</p>

<h2>Prepare Questions in Advance</h2>
<p>Doctor visits are short and often stressful. Having a written list of questions ensures that important topics get addressed. Encourage your parent to add questions as they think of them throughout the week, and review the list together before each appointment.</p>

<p>Post-visit, review what was discussed and ensure follow-up tasks are captured and assigned. A simple "Who does what by when?" framework prevents things from falling through the cracks.</p>

<h2>Make It a Team Effort</h2>
<p>Healthcare management works best when it''s collaborative. Divide responsibilities among family members based on proximity, availability, and skills. One person might handle appointment scheduling, another manages medications, and another serves as the primary emergency contact.</p>

<p>Clear roles reduce duplication, prevent gaps, and lower the stress on any single family member.</p>',
 'tips', '🩺', '#6B21A8', '#9333EA', true, '2026-02-20T12:00:00Z'),

('reducing-caregiver-burnout',
 'Caregiver Burnout Is Real — Here''s How to Prevent It',
 'Over 60% of family caregivers experience burnout. Recognizing the signs early and using the right tools can help you sustain your caregiving journey.',
 '<h2>The Silent Epidemic</h2>
<p>More than 53 million Americans serve as unpaid family caregivers. Among them, the AARP reports that more than 60% experience symptoms of burnout — including chronic exhaustion, withdrawal from friends and activities, anxiety, depression, and declining physical health.</p>

<p>Caregiver burnout doesn''t happen overnight. It builds gradually, often unnoticed, until the person doing the caring reaches a breaking point.</p>

<h2>Recognizing the Signs</h2>
<p>Burnout often starts with subtle changes. You might notice increased irritability, difficulty sleeping, loss of interest in things you used to enjoy, or a growing sense of resentment toward the person you''re caring for — followed immediately by guilt about feeling that way.</p>

<p>Physical symptoms are common too: headaches, frequent illness, weight changes, and chronic fatigue that doesn''t improve with rest.</p>

<p>If you recognize yourself in any of these descriptions, you''re not failing. You''re human. And there are concrete steps you can take.</p>

<h2>Setting Boundaries (Without Guilt)</h2>
<p>Boundaries aren''t selfish — they''re survival. Decide what you can realistically do and communicate that clearly to siblings, your parent, and yourself. "I can call every evening and visit twice a month" is more sustainable than "I''ll handle everything."</p>

<p>Saying no to some things means you can say yes to the things that matter most — and show up as your best self when you do.</p>

<h2>Leveraging Technology</h2>
<p>Technology can shoulder some of the daily mental load that drives burnout. Automated medication reminders mean you don''t have to make that daily call. A family dashboard means you can check in without picking up the phone. Shared calendars mean appointments don''t live solely in your head.</p>

<p>Sage Companion was built specifically to reduce the caregiving burden. When Sage handles daily check-ins, medication tracking, and appointment management, family caregivers can redirect that energy toward meaningful connection instead of logistics.</p>

<h2>Finding Your Support System</h2>
<p>Caregiver support groups — both in-person and online — provide a safe space to share frustrations, exchange practical advice, and simply feel understood. The Caregiver Action Network, Family Caregiver Alliance, and AARP all offer resources and community connections.</p>

<p>Respite care services can also give you a break. Even a few hours a week of professional support can make a significant difference in your wellbeing.</p>

<h2>You Matter Too</h2>
<p>The most important thing to remember: you cannot care for someone else if you don''t care for yourself. Regular exercise, adequate sleep, social connection, and professional support when needed aren''t luxuries — they''re essentials.</p>

<p>Caregiving is a marathon, not a sprint. Pace yourself accordingly.</p>',
 'caregiving', '❤️', '#9F1239', '#E11D48', true, '2026-02-14T12:00:00Z'),

('seniors-and-technology',
 'Helping Seniors Embrace Technology Without the Frustration',
 'The key isn''t teaching seniors to use technology — it''s building technology that works the way they already think. Here''s what that looks like in practice.',
 '<h2>The Real Problem Isn''t What You Think</h2>
<p>When a senior struggles with technology, we often blame a "learning curve." But the real problem is usually the other way around — the technology wasn''t designed with them in mind.</p>

<p>Small text, complex navigation, passwords they can''t remember, updates that change everything they just learned — these are design failures, not user failures.</p>

<h2>Design for How Seniors Actually Think</h2>
<p>Good senior-friendly technology follows a few key principles. First: reduce choices. Every additional button, menu, or option increases cognitive load. The best interfaces for seniors do one thing well and make that one thing obvious.</p>

<p>Second: use natural interactions. Voice is the most natural interface humans have. A senior who struggles with a touchscreen can have a fluent conversation. Building technology around voice removes the biggest barrier to adoption.</p>

<p>Third: be forgiving. Mistakes should be easy to undo, and the system should never make the user feel stupid. Patient, encouraging responses ("No problem! Let me try that again.") make all the difference.</p>

<h2>Start With One Thing</h2>
<p>Don''t introduce five new tools at once. Start with one thing that solves a real problem your parent has today. Maybe it''s medication reminders. Maybe it''s a way to video call grandchildren. Maybe it''s just having someone to talk to in the morning.</p>

<p>Success with one tool builds confidence for the next. And confidence is the single biggest predictor of technology adoption in older adults.</p>

<h2>The Role of Family</h2>
<p>Family support during the adoption phase is crucial — but it needs to be patient support, not frustrated tech support. A common mistake is taking over ("Here, let me just do it") instead of guiding ("You''re almost there — try the green button").</p>

<p>Set up the technology when you''re visiting. Walk through it together a few times. Then step back and let them explore. Be available for questions without hovering.</p>

<h2>What We Built at Sage Companion</h2>
<p>When we designed Sage, we started by watching how seniors actually interact with devices. We noticed they''re most comfortable with two things: talking and tapping large, clear buttons.</p>

<p>So that''s what Sage is. A big microphone button that starts a conversation. Large, clear icons for medications, calendar, and doctor visits. No passwords to remember (we use secure device-based tokens). No complex menus. No updates that rearrange everything.</p>

<p>The result? Seniors who "can''t do technology" are having daily conversations with Sage — and enjoying it.</p>

<h2>The Best Technology Disappears</h2>
<p>Ultimately, the best technology for seniors is technology they stop thinking of as technology. When your parent says "I was talking to Sage this morning" the same way they''d say "I was talking to my friend this morning," you know the design worked.</p>

<p>That''s the standard we aim for. Every day.</p>',
 'technology', '📱', '#0F172A', '#334155', true, '2026-02-07T12:00:00Z')

ON CONFLICT (slug) DO NOTHING;

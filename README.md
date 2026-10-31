# AgenticCore HQ

Fahad's personal AI team on Telegram, running on his own Windows VPS.

- **Boss: Claude Opus 5.5 at max effort**, on the Claude Agent SDK (the same engine as Claude Code): it reads files, runs commands, plans, checks its own work and keeps the conversation going. `/model fable` switches to Claude Fable 5.1 for the hardest jobs.
- **Specialists** the boss hands work to: Developer, Researcher, Marketing, Creative.
- **Other AIs as tools:**
  - **GPT** (OpenAI, newest model, high reasoning plus web search): campaigns and copy.
  - **Gemini** (newest Pro, high thinking plus Google Search): research with sources.
  - **Grok:** trends, images, video and voice.
- **Voice:** it understands your voice notes, and replies by voice **only when you ask**, in Urdu (Naksh) or English (Orion).
- **Always replies:** if something is unclear it asks. Long jobs send short updates and a final report.
- **Safe by default:**
  - It answers only your Telegram account.
  - Risky actions (push, merge, deploy, delete, live database changes) wait for your ✅ Allow button.
  - API keys are never readable by the AI.
  - There's a daily spending cap.

## Install on the Windows VPS (once, about 10 minutes)

1. Connect to the VPS with Remote Desktop and open **PowerShell as Administrator** (Start, type PowerShell, right-click, Run as administrator).
2. Install Git and download HQ. Sign in to GitHub in the browser window if asked:
   ```powershell
   winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
   $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
   git clone https://github.com/fahadsultanemirates-creator/agenticcore-hq C:\AgenticCoreHQ
   ```
3. Run the setup:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\setup.ps1
   ```
   It installs Node.js and GitHub CLI, then asks for:
   - **Telegram bot token** (from @BotFather)
   - **your Telegram user id** (message **@userinfobot** in Telegram to get it)
   - **Claude API key**
   - **OpenAI, Gemini and xAI keys** (optional, press Enter to skip any)
   - **a GitHub token** (optional, for coding work)
   - **a daily Claude spending cap**

   Keys are typed into the VPS only and saved in `C:\AgenticCoreHQ\.env`, readable by Administrators only.
4. Open your bot in Telegram, press **Start**, and send `/help`. You should also get an "HQ is online" message.

HQ runs in the background and starts by itself whenever the VPS restarts.

## Stage 2: browser, Facebook, WhatsApp, Buffer, Netlify, Supabase, video

Run once, connected to the VPS with Remote Desktop, in PowerShell as Administrator (after `update.ps1`):

```powershell
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\stage2.ps1
```

It:
1. Installs **ffmpeg** (the video tool) in `C:\AgenticCoreHQ\tools\ffmpeg`.
2. Asks for your **Netlify** token and up to **3 Supabase** tokens, each with a name like "Estate + PK". You type these on the VPS only.
3. Sets up the **AgenticCore browser**: an Edge window with its own profile. It starts whenever you log in to the VPS, and the bot drives it through a local-only connection. Files downloaded there go to `workspace\downloads`.
4. Opens Facebook, WhatsApp Web, Buffer, Netlify and Supabase in that window. **Log in to each once.**
5. Restarts the bot.

Keep that Edge window open; minimising it is fine. Close Remote Desktop with the **X**, never **Sign out**. After a VPS restart, connect with Remote Desktop once so the browser starts again. `/browser` in Telegram tells you whether it's running.

## AgenticCore Lite (the cost-effective second bot)

Same code, same rules and tools, cheaper models and smaller spending caps. Use it for everyday jobs like social media, browsing, captions, small Supabase/Netlify/GitHub tasks and simple pages. Keep HQ for hard coding and big decisions.

| | HQ | Lite |
|---|---|---|
| Manager | Claude Opus 5.5, max | Claude Sonnet 5.5, medium |
| Specialists | Opus (developer xhigh, others high) | Sonnet 5.5, medium |
| Scout (browsing, reading, collecting) | none | Claude Haiku 5.5, low |
| GPT / Gemini / Grok | GPT-6 Astra xhigh / 3.8 Flash high / Grok 4.7 high | GPT-6.1 Sol medium / 3.8 Flash low / Grok 4.7 low |
| Caps | $8 per job, your daily cap | $1.50 per job, $10 per day |

Install it once, on the VPS, in PowerShell as Administrator (HQ must be set up first). You'll need a second bot from @BotFather:

```powershell
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\lite.ps1
```

It copies the code to `C:\AgenticCoreHQ-Lite`, reuses HQ's API keys, asks only for the Lite bot's Telegram token, and starts Lite's own task and its own Edge window. That window uses port 9223, so you log in to Facebook and WhatsApp there once. It also starts Lite with HQ's profile and memory notes. Every Lite setting is in `C:\AgenticCoreHQ-Lite\.env`.

To update Lite later, run `powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Lite\scripts\update.ps1`. Each copy's `update.ps1` restarts only that copy.

## Lite on Gemini (optional)

Lite can run on Gemini instead of Claude. HQ and Outreach are not affected. Lite keeps the whole framework (tools, browser, approvals, budgets, Telegram). A small local gateway (LiteLLM, on 127.0.0.1 only) translates the Claude engine's requests to Gemini, using `GEMINI_API_KEY` from Lite's `.env`.

```
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Lite\scripts\lite-gemini.ps1          # switch to Gemini
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Lite\scripts\lite-gemini.ps1 -Revert  # back to Claude
```

| Role | Model (looked up from your key) | Thinking |
|---|---|---|
| Manager (talks with you) | newest `gemini-3.8-flash` | medium |
| Helpers | same as the manager | medium |
| Scout and quick replies | newest `gemini-3.5-flash` | low |
| Hard jobs (`/model fable`) | newest `gemini-4` pro | high |

- To force a specific id, set `LITE_GEMINI_MAIN`, `LITE_GEMINI_HELPER`, `LITE_GEMINI_SCOUT` or `LITE_GEMINI_HARD` in `.env` and run the script again.
- The script installs Python and LiteLLM if needed. It registers the task "AgenticCore Lite Gateway" (starts with the VPS) and keeps the old Claude settings so `-Revert` can restore them.
- **Several Gemini keys** (for example a free-tier project and a paid one): add one line per key to Lite's `.env`, like `GEMINI_KEY_FREE=...` and `GEMINI_KEY_PAID=...`, then run the script again. In Telegram, `/key` shows the keys and which one is in use, and `/key free` switches at once (no restart). `/key default` goes back to `GEMINI_API_KEY`. Keys are only ever typed on the VPS.
- **Automatic switching** (on by default when extra keys exist): Lite starts the day on the first extra key. When a key reaches its limit, it switches to the next one in `.env` order, ending on the default (paid) `GEMINI_API_KEY`. It tells you in Telegram each time and continues the task. At midnight Pacific time (when free limits reset) it goes back to the first key. `GEMINI_KEY_AUTO=0` turns it off.
- The `$` figures in `/cost` are estimates on Gemini. The real bill is in Google AI Studio, so set a spend limit there.

## AgenticCore Mini (the very cheap fourth bot)

Mini is a fourth copy for small daily tasks: chat, quick research, captions and posts, checking pages. It runs on the cheapest Gemini models with a lean tool set (no Supabase, Netlify or GitHub, which stay with HQ). HQ, Lite and Outreach are not touched. It has its own Telegram bot, folder (`C:\AgenticCoreHQ-Mini`), Edge window (port 9225) and gateway (port 4124). It uses the same Gemini keys as Lite: free ones first, then the paid one, switching automatically, with `/key` to switch by hand.

```
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\lite.ps1 -Edition mini
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Mini\scripts\lite-gemini.ps1
```

| Role | Model | Thinking | Free tier (per key) |
|---|---|---|---|
| Manager | `gemini-3.5-flash-lite` | medium | 15/min, 500/day |
| Helpers | `gemini-3.5-flash-lite` | low | (shared with the manager) |
| Scout and quick replies | `gemini-3.1-flash-lite` | low | 15/min, 500/day |
| Hard jobs (`/model fable`) | `gemini-3.8-flash` | medium | 5/min, 20/day |

The models and thinking levels can be changed in Mini's `.env` (`LITE_GEMINI_*`, `LITE_GEMINI_*_EFFORT`), then run `lite-gemini.ps1` again.

## AgenticCore Outreach (the field team for the outreach plan)

A third copy for the Global Outreach Plan (the .agency, .biz and .click brands; Pakistan real estate and the PK/estate sites are out of scope). The Sonnet manager only talks and plans. It has no browser: research and Gmail sending go to the Haiku scout, and everything else goes to helpers or plain code.

```
powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\lite.ps1 -Edition outreach
```

- Folder: `C:\AgenticCoreHQ-Outreach`. It has its own Telegram bot (a new token from @BotFather) and its own Edge window on port 9224. Log in there to the outreach accounts only (the new Gmail, the new Facebook and the new WhatsApp Business), never to your main ones.
- Set the sending accounts in `.env`: `OUTREACH_EMAIL_ACCOUNTS=a@gmail.com,b@gmail.com`. `OUTREACH_EMAIL_PER_ACCOUNT=8` is the daily cap per account.
- The CRM is CSV sheets in `workspace\outreach`: `leads.csv`, `touches.csv`, `suppression.csv` and `ideas.csv`. Put the prepared campaign pack (templates, posts, videos) in `workspace\outreach\campaign`.
- Rules enforced in code:
  - Leads need evidence and a personal hook. No Pakistan real estate. No duplicates within 90 days. The opt-out and bounce list is respected.
  - An email goes out only after you approve the day's batch, with one Send click per reserved email and each account's daily cap.
- It starts in **test mode**: no daily jobs, it works only on what you ask and then stops. `/auto on` starts the daily routine and `/auto off` stops it.
- With `/auto on`, daily, Dubai time: research at 03:00 (at most 15 new leads); the full report at 10:00 (the last 24 hours: activity, what got interest, what is not working, new data, field ideas, then the email batch for approval); the evening check at 20:30.
- Commands: `/report` (the report now), `/send` (send today's approved emails), `/leads` (the sheet), `/auto on|off` (the daily routine).

## Using it

Just talk to it: text or voice notes, in English, Urdu or Roman Urdu. Send photos or files and it saves them to its workspace.

| Command | What it does |
|---|---|
| `/new` | Start a fresh conversation (long-term memory stays) |
| `/stop` | Stop the current job |
| `/status` | What it's doing right now |
| `/cost` | Spending per day |
| `/budget 50` | Raise today's Claude cap to $50 |
| `/model main` · `opus` · `sonnet` · `haiku` · `fable` | Which Claude leads (`main` = this bot's default) |
| `/effort max` · `xhigh` · `high` · `medium` · `low` | How hard it thinks (default max) |
| `/models` | Which GPT / Gemini / Grok models it's using (`/models all` lists the choices) |
| `/use gemini <model>` | Pick a model yourself (`/use gemini auto` = newest again) |
| `/bigjob 40` | The next job may spend up to $40 (long campaigns, new projects) |
| `/browser` | Is the AgenticCore browser running? |

Things to try:
- "Research DHA Lahore 10 marla house prices this month and give me sources."
- "Plan a 2-week Facebook and Instagram campaign for AgenticCore Estate, captions in Roman Urdu."
- "Make 3 flyer designs for a 5 marla house in Bahria Town, compare Grok and OpenAI."
- "Every morning at 9, check open pull requests on both sites and tell me."
- "Is waqt kya ho raha hai? Bol kar batao." (voice reply)
- "Search Facebook groups for 10 marla plots in DHA Lahore posted this week and make me a list."
- "Join these 3 clips in order into one 45-second Reel and add the logo at the end."
- "Sign up on agenticcore.estate as a test user, list a test property, and tell me what breaks."
- "Schedule this image with this caption on Buffer for Friday 7pm." 

## Good to know

- **Approvals:** you get a message with ✅ Allow / ❌ Deny (or reply yes / no) when HQ wants to:
  - push code, merge, deploy, delete files or change live data;
  - change anything on Netlify or Supabase, or run SQL that writes;
  - click Post / Publish / Schedule / Send / Delete / Pay in the browser, or send a comment or message;
  - publish anything, message anyone other than you, or create a new account, project or repository.

  No answer within 15 minutes means no. The Agenticcore-token project is always off limits.
- **Big files:** Telegram bots can't take files over 20 MB. Send big videos to yourself on WhatsApp ("Message yourself") and tell HQ to take them from WhatsApp Web.
- **Memory:** `workspace\CLAUDE.md` (your profile, projects and rules) and `workspace\memory\notes.md` (what it learns) are read at the start of every conversation. Say "remember that…" to add to it.
- **Spending:**
  - Claude's cost is tracked per job, with a cap per job (`JOB_BUDGET_USD`, $8 by default) and per day (`DAILY_BUDGET_USD`).
  - Max effort is the strongest and also the most expensive setting. Use `/effort high` for everyday work if you want lower bills.
  - OpenAI, Gemini and xAI bill on their own dashboards. Set monthly limits there too.
- **Model names:** GPT, Gemini and Grok models are picked automatically: the newest flagship your key can use. Run `npm run models` in `C:\AgenticCoreHQ` to see them, or set `OPENAI_MODEL` / `GEMINI_MODEL` / `XAI_MODEL` in `.env`.
- **Logs:** `C:\AgenticCoreHQ\logs\hq.log`
- **Update to the latest version:** `powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\update.ps1`
- **Change keys:** run `setup.ps1` again and answer **n** to "keep it".

## For developers

Node 20+, ES modules, no build step. `npm test` runs the tests with fake Telegram, provider and Claude engines (no network, no cost).

- `src/index.js`: Telegram polling, commands, voice notes and files, scheduler
- `src/boss.js`: jobs on the Claude Agent SDK, sessions, approvals, cost
- `src/prompt.js`: the boss's instructions and the four specialists
- `src/tools.js`: HQ tools (tell_owner, send_file, speak, ask_gpt / gemini / grok, images, video, memory, schedules, spending)
- `src/guard.js`: what runs freely, what needs approval, what is never allowed
- `src/providers/`: OpenAI, Gemini, xAI
- `workspace-template/`: the starting CLAUDE.md and memory

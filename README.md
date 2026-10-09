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

## Using it

Just talk to it: text or voice notes, in English, Urdu or Roman Urdu. Send photos or files and it saves them to its workspace.

| Command | What it does |
|---|---|
| `/new` | Start a fresh conversation (long-term memory stays) |
| `/stop` | Stop the current job |
| `/status` | What it's doing right now |
| `/cost` | Spending per day |
| `/budget 50` | Raise today's Claude cap to $50 |
| `/model opus` · `fable` · `sonnet` | Which Claude leads (default opus) |
| `/effort max` · `xhigh` · `high` · `medium` · `low` | How hard it thinks (default max) |
| `/models` | Which GPT / Gemini / Grok models it's using |

Things to try:
- "Research DHA Lahore 10 marla house prices this month and give me sources."
- "Plan a 2-week Facebook and Instagram campaign for AgenticCore Estate, captions in Roman Urdu."
- "Make 3 flyer designs for a 5 marla house in Bahria Town, compare Grok and OpenAI."
- "Every morning at 9, check open pull requests on both sites and tell me."
- "Is waqt kya ho raha hai? Bol kar batao." (voice reply)

## Good to know

- **Approvals:** when HQ wants to push code, merge, deploy, delete files or change live data, you get a message with ✅ Allow / ❌ Deny. No answer within 15 minutes means no.
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

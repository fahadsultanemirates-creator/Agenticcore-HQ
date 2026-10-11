// Outreach edition: a simple CSV "CRM" (leads, touch log, suppression list, ideas)
// that the team fills, plus the rules from Fahad's outreach plan enforced in code,
// not left to the model: quality gates on every new lead, a shared suppression
// list, per-Gmail-account daily email caps, and "send" only for emails Fahad
// approved in a batch. Files live in workspace/outreach/ so the bot can send them
// to him and he can open them on his phone.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

// Columns from the plan's target_list_template (Section 5).
export const LEAD_COLUMNS = ['lead_id', 'date_added', 'region', 'country', 'city', 'timezone', 'brand_fit', 'icp_segment', 'company_name',
  'website', 'website_status', 'industry', 'company_size_est', 'first_name', 'last_name', 'role', 'business_email', 'email_source_url',
  'email_verified', 'phone_business_public', 'whatsapp_optin', 'linkedin_url', 'x_handle', 'instagram_handle', 'facebook_url',
  'telegram_handle', 'reddit_username', 'source_platform', 'source_url', 'discovery_query', 'intent_signal', 'personalization_hook',
  'pain_point', 'recommended_service', 'price_reference', 'priority_score', 'primary_channel', 'secondary_channel', 'lawful_basis',
  'strict_region_flag', 'do_not_contact', 'status', 'touch1_date', 'touch1_channel', 'touch2_date', 'touch3_date', 'last_reply_date',
  'reply_sentiment', 'next_action', 'next_action_date', 'call_booked', 'order_value_usd', 'notes'];
const TOUCH_COLUMNS = ['at', 'lead_id', 'channel', 'account_used', 'template_id', 'brand', 'touch_no', 'outcome', 'note'];
const SUPPRESS_COLUMNS = ['value', 'channel', 'date', 'reason'];
const IDEA_COLUMNS = ['at', 'idea', 'evidence', 'source', 'status'];
const OUTCOMES = ['sent', 'replied', 'positive', 'negative', 'bounced', 'opted-out', 'call-booked', 'order', 'no-reply'];

// ---------- tiny CSV ----------
const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCsv(cols, rows) { return [cols.join(',')].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\n') + '\n'; }
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
}

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|gmx|mail|yandex)\./i;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
const REAL_ESTATE = /real[\s-]?estate|realt(y|or)|property|properties|estate agent|broker(age)?|زمین|plot|marla|housing society/i;
const PAKISTAN = /^(pk|pak|pakistan)$/i;
const OWN_PK_SITES = /agenticcore\.estate|agenticcorepk\.com/i;
export const domainOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const norm = (s) => String(s || '').trim().toLowerCase();

export function makeOutreach({ dir, now = () => new Date(), emailCapPerAccount = 8, accounts = [], tokenTtlMs = 10 * 60000 }) {
  fs.mkdirSync(path.join(dir, 'campaign'), { recursive: true });
  const f = (n) => path.join(dir, n);
  const read = (n) => (fs.existsSync(f(n)) ? parseCsv(fs.readFileSync(f(n), 'utf8')) : []);
  const write = (n, cols, rows) => { const tmp = f(n) + '.tmp'; fs.writeFileSync(tmp, toCsv(cols, rows)); fs.renameSync(tmp, f(n)); };
  for (const [n, cols] of [['leads.csv', LEAD_COLUMNS], ['touches.csv', TOUCH_COLUMNS], ['suppression.csv', SUPPRESS_COLUMNS], ['ideas.csv', IDEA_COLUMNS]]) {
    if (!fs.existsSync(f(n))) write(n, cols, []);
  }
  const today = () => now().toISOString().slice(0, 10);
  const leads = () => read('leads.csv');
  const saveLeads = (rows) => write('leads.csv', LEAD_COLUMNS, rows);

  function suppressedValues() { return new Set(read('suppression.csv').map((r) => norm(r.value)).filter(Boolean)); }
  function isSuppressed(lead, sup = suppressedValues()) {
    const keys = [lead.business_email, domainOf(lead.website || ''), lead.x_handle, lead.instagram_handle, lead.linkedin_url, lead.telegram_handle, lead.phone_business_public].map(norm).filter(Boolean);
    return keys.some((k) => sup.has(k));
  }

  // Quality gates from the plan. Returns { added: [...ids], rejected: [{ company, reason }] }.
  function addLeads(rows) {
    const all = leads();
    const sup = suppressedValues();
    const added = [], rejected = [];
    const ninetyDaysAgo = new Date(now().getTime() - 90 * 86400000).toISOString().slice(0, 10);
    for (const raw of rows || []) {
      const lead = Object.fromEntries(LEAD_COLUMNS.map((c) => [c, raw[c] == null ? '' : String(raw[c]).trim()]));
      const name = lead.company_name || lead.website || '(no name)';
      const reject = (reason) => rejected.push({ company: name, reason });
      if (PAKISTAN.test(lead.country) && REAL_ESTATE.test([lead.industry, lead.icp_segment, lead.company_name, lead.notes].join(' '))) { reject('Pakistan real estate is out of scope'); continue; }
      if (OWN_PK_SITES.test(JSON.stringify(lead))) { reject('mentions agenticcore.estate / agenticcorepk.com'); continue; }
      if (!/^https?:\/\//i.test(lead.source_url)) { reject('no evidence (source_url)'); continue; }
      if (!lead.personalization_hook) { reject('no personal hook'); continue; }
      if (lead.business_email && !EMAIL_RE.test(lead.business_email)) lead.business_email = '';
      if (lead.business_email && lead.strict_region_flag.toUpperCase() === 'Y' && FREE_MAIL.test(lead.business_email)) {
        lead.business_email = ''; lead.notes = (lead.notes ? lead.notes + ' | ' : '') + 'personal email removed (strict region)';
      }
      if (lead.business_email && !lead.email_source_url) { lead.business_email = ''; lead.notes = (lead.notes ? lead.notes + ' | ' : '') + 'email removed: no source'; }
      if (isSuppressed(lead, sup)) { reject('on the suppression list'); continue; }
      const dom = domainOf(lead.website);
      const sameCompany = all.filter((l) => (dom && domainOf(l.website) === dom) || (lead.business_email && norm(l.business_email) === norm(lead.business_email))
        || (norm(l.company_name) && norm(l.company_name) === norm(lead.company_name) && norm(l.country) === norm(lead.country)));
      const cap = /51|\+/.test(lead.company_size_est) ? 2 : 1;
      if (sameCompany.some((l) => l.touch1_date && l.touch1_date >= ninetyDaysAgo)) { reject('contacted in the last 90 days'); continue; }
      if (sameCompany.length >= cap) { reject('already in the list'); continue; }
      const n = all.filter((l) => l.date_added === today()).length + 1;
      lead.lead_id = today().replace(/-/g, '') + '-' + (lead.country || 'XX').toUpperCase().slice(0, 3) + '-' + String(n).padStart(4, '0');
      lead.date_added = today();
      lead.status = lead.status || 'new';
      lead.do_not_contact = lead.do_not_contact || 'N';
      lead.email_verified = lead.email_verified || (lead.business_email ? 'not-checked' : '');
      all.push(lead); added.push(lead.lead_id);
    }
    saveLeads(all);
    return { added, rejected };
  }

  function listLeads({ status, minScore, region, brand, hasEmail, limit = 50 } = {}) {
    return leads().filter((l) => (!status || l.status === status) && (!minScore || Number(l.priority_score) >= minScore)
      && (!region || norm(l.region) === norm(region)) && (!brand || norm(l.brand_fit) === norm(brand))
      && (!hasEmail || l.business_email)).slice(0, limit);
  }

  function updateLead(id, fields) {
    const all = leads();
    const l = all.find((x) => x.lead_id === id);
    if (!l) throw new Error('no lead ' + id);
    for (const [k, v] of Object.entries(fields || {})) if (LEAD_COLUMNS.includes(k) && k !== 'lead_id') l[k] = String(v ?? '');
    saveLeads(all);
    return l;
  }

  function suppress({ value, channel = 'any', reason = 'opt-out' }) {
    const v = norm(value);
    if (!v) throw new Error('nothing to suppress');
    const rows = read('suppression.csv');
    if (!rows.some((r) => norm(r.value) === v)) { rows.push({ value: v, channel, date: today(), reason }); write('suppression.csv', SUPPRESS_COLUMNS, rows); }
    const all = leads();
    for (const l of all) if (isSuppressed(l, new Set([v]))) { l.do_not_contact = 'Y'; if (/opt/.test(reason)) l.status = 'opted-out'; }
    saveLeads(all);
  }

  function logTouch({ lead_id, channel, account_used = '', template_id = '', touch_no = '', outcome, note = '' }) {
    if (!OUTCOMES.includes(outcome)) throw new Error('outcome must be one of: ' + OUTCOMES.join(', '));
    const all = leads();
    const l = all.find((x) => x.lead_id === lead_id);
    if (!l) throw new Error('no lead ' + lead_id);
    const rows = read('touches.csv');
    rows.push({ at: now().toISOString(), lead_id, channel, account_used, template_id, brand: l.brand_fit, touch_no, outcome, note: String(note).slice(0, 300) });
    write('touches.csv', TOUCH_COLUMNS, rows);
    const d = today();
    if (outcome === 'sent') {
      const n = Number(touch_no) || (l.touch3_date ? 4 : l.touch2_date ? 3 : l.touch1_date ? 2 : 1);
      if (n === 1) { l.touch1_date = d; l.touch1_channel = channel; } else if (n === 2) l.touch2_date = d; else if (n === 3) l.touch3_date = d;
      if (l.status === 'new') l.status = 'contacted';
    }
    if (['replied', 'positive', 'negative'].includes(outcome)) { l.status = 'replied'; l.last_reply_date = d; l.reply_sentiment = outcome === 'replied' ? 'neutral' : outcome; }
    if (outcome === 'call-booked') { l.status = 'call-booked'; l.call_booked = 'Y ' + d; }
    if (outcome === 'order') l.status = 'won';
    saveLeads(all);
    if (outcome === 'bounced' && l.business_email) suppress({ value: l.business_email, channel, reason: outcome });
    if (outcome === 'opted-out') for (const v of [l.business_email, domainOf(l.website)].filter(Boolean)) suppress({ value: v, channel, reason: outcome });   // the company said no
  }

  // ---------- email: approved batch → one send token per email, per-account daily cap ----------
  // lead_id → { account, subject, body, approvedOn }; kept in a file so a restart does not lose today's approval
  const approvedFile = f('approved.json');
  const loadApproved = () => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(approvedFile, 'utf8')))); } catch { return new Map(); } };
  const saveApproved = (m) => fs.writeFileSync(approvedFile, JSON.stringify(Object.fromEntries(m), null, 1));
  let tokens = [];                  // [{ expires }] one per reserved email; the guard spends one per "Send" click
  const sentToday = (account) => read('touches.csv').filter((t) => t.channel === 'email' && t.outcome === 'sent' && t.at.slice(0, 10) === today() && (!account || norm(t.account_used) === norm(account))).length;

  function approveBatch(items) {
    const approved = loadApproved();
    for (const it of items) approved.set(it.lead_id, { account: it.account || '', subject: it.subject, body: it.body, approvedOn: today() });
    saveApproved(approved);
  }
  function pendingApproved() { return [...loadApproved().entries()].filter(([, v]) => v.approvedOn === today()).map(([lead_id, v]) => Object.assign({ lead_id }, v)); }

  function pickAccount(wanted) {
    const list = accounts.length ? accounts : (wanted ? [wanted] : []);
    if (!list.length) throw new Error('no sending account set (OUTREACH_EMAIL_ACCOUNTS in .env)');
    const ok = list.filter((a) => sentToday(a) < emailCapPerAccount);
    if (wanted && ok.map(norm).includes(norm(wanted))) return wanted;
    if (!ok.length) throw new Error('every sending account has reached today\'s limit of ' + emailCapPerAccount + ' emails');
    return ok.sort((a, b) => sentToday(a) - sentToday(b))[0];
  }

  // Before clicking Send in Gmail: checks the batch approval, suppression and caps, returns what to send.
  function reserveSend(lead_id) {
    const approved = loadApproved();
    const a = approved.get(lead_id);
    if (!a || a.approvedOn !== today()) throw new Error('this email was not in a batch Fahad approved today');
    const l = leads().find((x) => x.lead_id === lead_id);
    if (!l) throw new Error('no lead ' + lead_id);
    if (!l.business_email) throw new Error('lead has no business email');
    if (l.do_not_contact === 'Y' || isSuppressed(l)) throw new Error('lead is on the suppression list');
    const account = pickAccount(a.account);
    approved.delete(lead_id);
    saveApproved(approved);
    tokens = tokens.filter((t) => t.expires > Date.now());
    tokens.push({ expires: Date.now() + tokenTtlMs });
    return { to: l.business_email, account, subject: a.subject, body: a.body, sent_today_from_account: sentToday(account), cap: emailCapPerAccount };
  }
  function spendSendToken() {
    tokens = tokens.filter((t) => t.expires > Date.now());
    if (!tokens.length) return false;
    tokens.shift();
    return true;
  }

  // ---------- report numbers (code, not AI) ----------
  function stats(hours = 24) {
    const since = new Date(now().getTime() - hours * 3600000).toISOString();
    const t = read('touches.csv').filter((x) => x.at >= since);
    const by = (key) => {
      const out = {};
      for (const x of t) {
        const k = x[key] || '(none)';
        out[k] = out[k] || { sent: 0, replies: 0, positive: 0, negative: 0, bounced: 0, optedOut: 0 };
        if (x.outcome === 'sent') out[k].sent++;
        if (['replied', 'positive', 'negative'].includes(x.outcome)) out[k].replies++;
        if (x.outcome === 'positive') out[k].positive++;
        if (x.outcome === 'negative') out[k].negative++;
        if (x.outcome === 'bounced') out[k].bounced++;
        if (x.outcome === 'opted-out') out[k].optedOut++;
      }
      return out;
    };
    const all = leads();
    const statusCount = {};
    for (const l of all) statusCount[l.status || 'new'] = (statusCount[l.status || 'new'] || 0) + 1;
    return {
      hours, touches: t.filter((x) => x.outcome === 'sent').length,
      byChannel: by('channel'), byTemplate: by('template_id'), byBrand: by('brand'),
      newLeads: all.filter((l) => l.date_added >= since.slice(0, 10)).length,
      totalLeads: all.length, leadsByStatus: statusCount,
      dueFollowUps: all.filter((l) => l.next_action_date && l.next_action_date <= today() && !['won', 'lost', 'opted-out'].includes(l.status)).length,
      emailsSentToday: sentToday(), emailCapPerAccount, accounts: accounts.map((a) => ({ account: a, sentToday: sentToday(a) })),
      newIdeas: read('ideas.csv').filter((i) => i.at >= since).map((i) => i.idea)
    };
  }

  function addIdea({ idea, evidence = '', source = '' }) {
    const rows = read('ideas.csv');
    rows.push({ at: now().toISOString(), idea: String(idea).slice(0, 500), evidence: String(evidence).slice(0, 500), source: String(source).slice(0, 200), status: 'new' });
    write('ideas.csv', IDEA_COLUMNS, rows);
  }
  const ideas = (status) => read('ideas.csv').filter((i) => !status || i.status === status);

  return { dir, addLeads, listLeads, updateLead, suppress, logTouch, approveBatch, pendingApproved, reserveSend, spendSendToken, stats, addIdea, ideas, sentToday };
}

// ---------- the team's tools (added to the "hq" tool server in the Outreach edition) ----------
const ok = (x) => ({ content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x, null, 1) }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'Failed: ' + (e && e.message ? e.message : e) }], isError: true });
const safe = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(e); } };
const leadShape = z.object(Object.fromEntries(LEAD_COLUMNS.filter((c) => c !== 'lead_id' && c !== 'date_added').map((c) => [c, z.union([z.string(), z.number()]).optional()])));

export function outreachTools({ outreach, approvals, tg, chatId }) {
  return [
    tool('outreach_add_leads', 'Add researched targets to the lead sheet (workspace/outreach/leads.csv). The plan\'s quality gates run in code: Pakistan real estate, missing source_url or hook, duplicates, suppression list, contacted in the last 90 days, 1 lead per company. Returns which were added and why others were rejected. Public business data only; always fill source_url, personalization_hook and, for emails, email_source_url.',
      { leads: z.array(leadShape).min(1).max(100) },
      safe(async ({ leads }) => ok(outreach.addLeads(leads)))),
    tool('outreach_list_leads', 'List leads from the sheet, filtered (status new/contacted/replied/…, minimum score, region, brand, only with email).',
      { status: z.string().optional(), min_score: z.number().optional(), region: z.string().optional(), brand: z.string().optional(), has_email: z.boolean().optional(), limit: z.number().int().max(200).optional() },
      safe(async (a) => ok(outreach.listLeads({ status: a.status, minScore: a.min_score, region: a.region, brand: a.brand, hasEmail: a.has_email, limit: a.limit })))),
    tool('outreach_update_lead', 'Update fields of one lead (score, drafts in notes, status, next_action, next_action_date…).',
      { lead_id: z.string(), fields: z.record(z.string(), z.union([z.string(), z.number()])) },
      safe(async ({ lead_id, fields }) => ok(outreach.updateLead(lead_id, fields)))),
    tool('outreach_log_touch', 'Record an outreach action or result: outcome sent / replied / positive / negative / bounced / opted-out / call-booked / order / no-reply. Opt-outs and bounces go on the suppression list automatically. Log every email sent and every social message Fahad reports sending.',
      { lead_id: z.string(), channel: z.string(), outcome: z.string(), account_used: z.string().optional(), template_id: z.string().optional(), touch_no: z.union([z.string(), z.number()]).optional(), note: z.string().optional() },
      safe(async (a) => { outreach.logTouch(a); return ok('logged'); })),
    tool('outreach_suppress', 'Put an email, website, handle or phone on the do-not-contact list (opt-out, complaint, Fahad\'s request). Shared across all brands and accounts.',
      { value: z.string(), channel: z.string().optional(), reason: z.string().optional() },
      safe(async (a) => { outreach.suppress(a); return ok('suppressed'); })),
    tool('outreach_request_email_batch', 'Ask Fahad to approve today\'s email batch: sends him the full drafts as a file plus an Allow / Deny message. Only approved emails can be sent. Each item: lead_id, subject, body (plain text, personal first line, max one link, the opt-out line), optional account.',
      { items: z.array(z.object({ lead_id: z.string(), subject: z.string().min(2).max(150), body: z.string().min(20).max(3000), account: z.string().optional() })).min(1).max(60) },
      safe(async ({ items }) => {
        const file = path.join(outreach.dir, 'email-batch-' + new Date().toISOString().slice(0, 10) + '.txt');
        fs.writeFileSync(file, items.map((it, i) => '#' + (i + 1) + '  ' + it.lead_id + '\nSubject: ' + it.subject + '\n\n' + it.body + '\n').join('\n------------------------------\n'));
        await tg.sendFile(chatId(), file, { caption: 'Today\'s email batch: ' + items.length + ' emails (full text)' }).catch(() => null);
        const r = await approvals.request(chatId(), 'send today\'s email batch (' + items.length + ' emails)', items.slice(0, 12).map((it) => '- ' + it.lead_id + ': ' + it.subject).join('\n') + (items.length > 12 ? '\n…and ' + (items.length - 12) + ' more (see the file)' : ''));
        if (!r.allowed) return ok('NOT approved (' + (r.note || 'denied') + '). Keep the drafts; he can send /send later to approve them.');
        outreach.approveBatch(items);
        return ok('APPROVED: ' + items.length + ' emails. Send them one at a time: outreach_reserve_send, then compose and click Send in Gmail, then outreach_log_touch (sent). Wait a few minutes between emails.');
      })),
    tool('outreach_reserve_send', 'Call right before sending ONE approved email. Checks approval, suppression and the per-account daily cap, picks the sending account, and unlocks exactly one Send click in Gmail. Returns to / account / subject / body to use exactly as approved.',
      { lead_id: z.string() },
      safe(async ({ lead_id }) => ok(outreach.reserveSend(lead_id)))),
    tool('outreach_stats', 'Numbers for reports, computed from the sheets: touches, replies and positives by channel, template and brand; new leads; leads by status; follow-ups due; emails sent per account; new ideas.',
      { hours: z.number().int().min(1).max(24 * 31).optional() },
      safe(async ({ hours }) => ok(outreach.stats(hours || 24)))),
    tool('outreach_add_idea', 'Record a new idea from the field: a new audience, channel, offer, angle, partnership or a pattern you noticed, with the evidence (what you saw, links, numbers). The 10am report shares the best ones.',
      { idea: z.string().min(5), evidence: z.string().optional(), source: z.string().optional() },
      safe(async (a) => { outreach.addIdea(a); return ok('idea saved'); }))
  ];
}

// Next time "HH:MM" happens in Dubai (UTC+4, no daylight saving), as an ISO string.
export function nextDubai(hhmm, now = new Date()) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const dubaiNow = new Date(now.getTime() + 4 * 3600000);
  const d = new Date(Date.UTC(dubaiNow.getUTCFullYear(), dubaiNow.getUTCMonth(), dubaiNow.getUTCDate(), h, m || 0) - 4 * 3600000);
  if (d <= now) d.setTime(d.getTime() + 86400000);
  return d.toISOString();
}

export const OUTREACH_JOBS = {
  research: 'Outreach research run. Read workspace/outreach/campaign/ (the plan, rotation, query bank and templates; if it is empty, use the defaults in your instructions and say so in the report). For today\'s focus region and brand: hand the searching and page-reading to the scout (public sources only), add at most 15 new targets with outreach_add_leads (fewer is fine; stop there), score them 1-5, and draft for the best ones the personal first line plus the Day 0 message per channel (email drafts: subject + body; social drafts go in the lead notes). Also prepare the Day 3 / Day 7 follow-ups that are due. Do not send anything. Record any new ideas with outreach_add_idea. Finish with a 3-line summary.',
  report: 'Morning report (10:00 Dubai). Use outreach_stats (24 hours) and check, through the scout, the Gmail inboxes for replies (log them with outreach_log_touch; opt-outs get suppressed) and how the latest posts did (reactions, comments, messages). Then send Fahad the report: 1) activity in the last 24h by channel, 2) replies and who looks interested, 3) which posts / templates / campaigns worked, 4) which are not getting anywhere and what to change or stop, 5) new leads and data found for the next moves, 6) the 3 best new ideas from the field with evidence, 7) today\'s plan. Short, phone-friendly, numbers first. Then, if there are email drafts ready for today, ask for approval with outreach_request_email_batch and, if approved, send them as instructed.',
  evening: 'Evening wrap-up. Through the scout, check the Gmail inboxes for new replies and log them; update lead statuses and next actions; schedule the Day 3 / Day 7 follow-ups. Only message Fahad if something needs him today (a hot reply, a problem); otherwise stay quiet.'
};

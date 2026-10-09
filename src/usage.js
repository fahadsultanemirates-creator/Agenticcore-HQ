// Spending: Claude cost per job (from the Agent SDK's own estimate) against a
// daily cap, plus a call count for the other providers. Days follow Pakistan time.

export function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function makeUsage(store, cfg, now = () => new Date()) {
  const blank = { days: {}, overrides: {} };

  function addClaude(usd) {
    const v = Math.max(0, Number(usd) || 0);
    store.update('usage', blank, (u) => {
      const d = (u.days[dayKey(now())] ||= { claude: 0, jobs: 0, calls: {} });
      d.claude = Math.round((d.claude + v) * 10000) / 10000; d.jobs += 1;
    });
    return v;
  }
  function addCall(provider) {
    store.update('usage', blank, (u) => {
      const d = (u.days[dayKey(now())] ||= { claude: 0, jobs: 0, calls: {} });
      d.calls[provider] = (d.calls[provider] || 0) + 1;
    });
  }
  const today = () => (store.read('usage', blank).days[dayKey(now())] || { claude: 0, jobs: 0, calls: {} });
  const cap = () => Number(store.read('usage', blank).overrides[dayKey(now())]) || cfg.dailyBudget;
  function setCapToday(usd) { store.update('usage', blank, (u) => { u.overrides[dayKey(now())] = Number(usd); }); }
  const left = () => Math.max(0, cap() - today().claude);

  function report(days = 7) {
    const u = store.read('usage', blank);
    const keys = Object.keys(u.days).sort().slice(-days);
    const lines = keys.map((k) => {
      const d = u.days[k];
      const calls = Object.entries(d.calls || {}).map(([p, n]) => p + ' ' + n).join(', ');
      return k + ': Claude $' + d.claude.toFixed(2) + ' (' + d.jobs + ' jobs)' + (calls ? ' · calls: ' + calls : '');
    });
    const total = keys.reduce((s, k) => s + u.days[k].claude, 0);
    return (lines.length ? lines.join('\n') : 'No spending recorded yet.') +
      '\n\nLast ' + keys.length + ' day(s) Claude total: $' + total.toFixed(2) +
      '\nToday: $' + today().claude.toFixed(2) + ' of $' + cap().toFixed(2) + ' daily cap' +
      '\n(Claude figures are the Agent SDK\'s estimate; OpenAI / Gemini / xAI are billed on their own dashboards.)';
  }

  return { addClaude, addCall, today, cap, left, setCapToday, report };
}

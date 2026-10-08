// Silverdale Canvassing: who we've written to, and everything about them.
// - A fail-safe so nobody gets a second letter by accident (Ash, 26 Sep 2026):
//   every folder row, register row and letter on the print list is checked
//   against the sent record by name (middle names ignored), by address and (for
//   planning leads) by their agent; sending a repeat always asks first.
// - Where each person stands: waiting, on the print list, printed and sent,
//   visited, not chasing.
// - Business trades (architect, engineer, builder, advocate...).
// - A full profile for anyone, opened by clicking their name anywhere.
// Depends on index.html for: getLog, saveLog, LS_LOG, leads, leadFolder, FOLDERS,
// esc, prettyDate, todayISO, getDismissed, parentRefOf, originalLineHtml, timings,
// loadTimings, relIdx, loadRelatedIndex, relatedListHtml, whatThisIsHtml,
// drawingsLinkHtml, letterHtml, privateJson, REGISTER_DATA_URL, render, state;
// and on market.js for estimateFor, estimateRowHtml, moneyRange.

(function injectContactStyles(){
  const css = `
  .contact-flag{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);color:var(--text);border-radius:6px;padding:5px 9px;margin:4px 0 6px;font-size:0.8rem;line-height:1.4}
  .contact-flag b{color:#ef4444}
  details.contacted-bar{background:var(--surf);border:1px solid var(--bord);border-radius:10px;padding:10px 14px;margin:0 0 14px}
  details.contacted-bar summary{cursor:pointer;font-weight:700;color:var(--accent)}
  table.contacted{width:100%;border-collapse:collapse;margin-top:10px;font-size:0.8rem}
  table.contacted th,table.contacted td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--bord);vertical-align:top}
  table.contacted th{color:var(--muted);font-weight:700;white-space:nowrap}
  table.contacted td.rep{color:#ef4444;font-weight:700}
  table.contacted tr.grp td{color:var(--accent);font-weight:800;font-size:0.72rem;letter-spacing:.06em;text-transform:uppercase;padding-top:12px}
  .contacted-warn{color:#ef4444;font-weight:700;margin:8px 0 0;font-size:0.85rem}
  .prof-name{background:none;border:0;padding:0;color:var(--text);font:inherit;font-weight:700;cursor:pointer;text-align:left}
  .prof-name:hover{color:var(--accent);text-decoration:underline}
  .fview-bar{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 14px}
  .fview-bar button{background:var(--surf2);color:var(--text);border:1px solid var(--bord);border-radius:999px;padding:6px 12px;font:inherit;font-size:0.82rem;cursor:pointer}
  .fview-bar button.on{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700}
  .trade-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 12px;font-size:0.8rem}
  .trade-bar button{background:transparent;color:var(--muted);border:1px solid var(--bord);border-radius:6px;padding:3px 9px;font:inherit;cursor:pointer}
  .trade-bar button.on{color:var(--text);border-color:var(--accent)}
  .trade-tag{display:inline-block;border:1px solid rgba(56,153,207,.5);color:#7cc4ea;border-radius:5px;padding:1px 7px;font-size:0.7rem;font-weight:700;margin-left:6px}
  .status-tag{display:inline-block;border-radius:5px;padding:2px 8px;font-size:0.72rem;font-weight:700}
  .status-tag.sent{background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.4)}
  .status-tag.print{background:rgba(245,158,11,.12);color:var(--accent);border:1px solid rgba(245,158,11,.4)}
  .status-tag.waiting{background:var(--surf2);color:var(--text);border:1px solid var(--bord)}
  .status-tag.archived{color:var(--muted);border:1px solid var(--bord)}
  .prof-overlay{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow:auto}
  .prof-panel{background:var(--surf);border:1px solid var(--bord);border-radius:12px;max-width:900px;width:100%;padding:20px 22px;position:relative}
  .prof-panel h2{font-size:1.25rem;margin:0 36px 4px 0}
  .prof-panel h3{font-size:0.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:18px 0 6px}
  .prof-close{position:absolute;top:12px;right:14px;background:var(--surf2);border:1px solid var(--bord);color:var(--text);border-radius:8px;width:32px;height:32px;font-size:1.1rem;cursor:pointer}
  .prof-panel .prof-links{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}
  .prof-panel .prof-links a{font-size:0.78rem}
  .prof-panel ul.prof-apps{margin:4px 0 0 18px;font-size:0.82rem;color:var(--muted)}
  .prof-panel ul.prof-apps li{margin:3px 0}
  .biz-add{background:var(--surf);border:1px solid var(--bord);border-radius:10px;padding:10px 14px;margin:0 0 14px}
  .biz-add summary{cursor:pointer;font-weight:700;color:var(--accent)}
  .biz-add .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-top:10px}
  .biz-add input,.biz-add textarea{width:100%}
  `;
  const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
})();

// ---- Matching people ----
function personNorm(name){
  if (/on (the )?register|not legible|illegible|unclear|not stated/i.test(name || '')) return '';   // placeholders, not people
  return (name || '').toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/\b(mr|mrs|ms|miss|dr|prof|sir|and|the|ltd|limited|plc|llp)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// "Samuel Samson" is "Samuel Thomas Samson"; "Andrew Bentley" is "Andrew J Bentley".
function samePerson(x, y){
  if (!x || !y) return false;
  if (x === y) return true;
  const a = x.split(' ').filter(t => t.length > 1), b = y.split(' ').filter(t => t.length > 1);
  return a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}
function postcodeOf(lines){
  const m = (lines || []).join(' ').match(/\bIM\d{1,2}\s?\d[A-Z]{2}\b/i);
  return m ? m[0].toUpperCase().replace(/\s+/g, '') : '';
}
// First address line plus postcode, so a household matches whichever name is on the letter.
function addrKey(lines){
  lines = stackLines(lines);
  const pc = postcodeOf(lines), first = ((lines || [])[1] || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return pc && first ? first + '|' + pc : '';
}

// ---- One letter per household (Ash's prime directive, 28 Sep 2026) ----
// The envelope address without the name line is the tell: the same house gets one letter, whoever it's addressed to.
// Written to in the last 6 months = LOCKED (can't send). Older than that = flagged, send if you mean to.
const LOCK_DAYS = 183;
const normLine = s => String(s || '').toLowerCase().replace(/\bisle of man\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function houseKeys(lines){
  lines = stackLines(lines);
  const addr = (lines || []).slice(1).map(x => String(x || '').trim()).filter(Boolean);
  if (!addr.length) return [];
  const txt = addr.join(', '), pc = postcodeOf(addr), keys = new Set();
  const flat = (txt.match(/\b(?:flat|apartment|apt|unit)\s*([a-z0-9]+)/i) || [])[1];
  const f = flat ? 'f' + flat.toLowerCase() + '|' : '';
  const rest = txt.replace(/\b(?:flat|apartment|apt|unit)\s*[a-z0-9]+\s*,?/i, '');
  const num = (rest.match(/(?:^|,\s*)(\d{1,4}[a-z]?)\b/i) || [])[1];
  if (typeof addrKeysOf === 'function') addrKeysOf(rest).forEach(k => keys.add('st:' + f + k));      // "18|governors road"
  if (pc && num) keys.add('pcn:' + f + pc + '|' + num.toLowerCase());                                  // postcode + house number
  const first = normLine(addr[0]);
  if (pc && first) keys.add('pcf:' + pc + '|' + first);                                                 // postcode + first address line
  if (first && !/^\d/.test(first) && first.length > 3 && addr[1]) keys.add('hn:' + first + '|' + normLine(addr[1]));   // house name + road
  return [...keys];
}
const sameHouse = (a, b) => a.length && b.length && a.some(k => b.includes(k));
const daysAgo = iso => iso ? Math.floor((Date.now() - new Date(iso + 'T12:00:00')) / DAY_MS) : null;
const lockedUntil = iso => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + LOCK_DAYS); return d.toISOString().slice(0, 10); };
const isLocked = c => c.date && c.why !== 'their agent' && daysAgo(c.date) < LOCK_DAYS;

// The sent record as a list, rebuilt only when it changes.
const CONTACTS = { raw: null, list: [] };
function sentContacts(){
  const raw = localStorage.getItem(LS_LOG) || '{}';
  if (raw !== CONTACTS.raw) {
    const log = getLog();
    CONTACTS.list = Object.entries(log).map(([ref, e]) => {
      const lines = stackLines(e.recipientLines || []);
      const name = e.name || lines[0] || '';
      const biz = ref.startsWith('ARCH-') || e.source === 'business';
      return { ref, e, name, lines, n: personNorm(name), a: addrKey(lines), h: biz ? [] : houseKeys(lines) };
    });
    CONTACTS.raw = raw;
  }
  return CONTACTS.list;
}

// Earlier letters to the same person, the same address or (planning leads) their agent,
// plus anyone else already on the print list for the same person.
function priorContacts(l){
  const n = personNorm(l.applicant || (l.recipientLines || [])[0]);
  const a = addrKey(l.recipientLines);
  const isBiz = (l.ref || '').startsWith('ARCH-') || (typeof leadFolder === 'function' && l.recipientLines && leads.includes(l) && leadFolder(l) === 'business');
  const h = isBiz ? [] : houseKeys(l.recipientLines);
  const agent = personNorm(l.agentText || '');
  const out = [];
  sentContacts().forEach(c => {
    const why = c.ref === l.ref ? 'this application'
      : sameHouse(h, c.h) ? 'same house'
      : samePerson(n, c.n) ? 'same name'
      : a && a === c.a ? 'same address'
      : agent && c.n.length > 4 && (agent.includes(c.n) || samePerson(agent, c.n)) ? 'their agent'
      : null;
    if (why) out.push({ ref: c.ref, name: c.name, date: c.e.date, copy: c.e.copy, why });
  });
  leads.forEach(o => {
    if (o === l || o.ref === l.ref || !o.include || o.alreadyProcessed) return;
    if (samePerson(n, personNorm(o.applicant)) || (a && addrKey(o.recipientLines) === a) || sameHouse(h, (o.ref || '').startsWith('ARCH-') || leadFolder(o) === 'business' ? [] : houseKeys(o.recipientLines))) out.push({ ref: o.ref, name: o.applicant, date: null, copy: leadFolder(o), why: 'also on the print list' });
  });
  return out.sort((x, y) => (y.date || '9').localeCompare(x.date || '9'));
}

function contactLine(c){
  const who = c.why === 'their agent' ? `Their agent, ${esc(c.name)},` : esc(c.name);
  if (c.why === 'also on the print list') return `${who} is also on the print list right now.`;
  const what = FOLDERS[c.copy] ? `the ${esc(FOLDERS[c.copy])} letter` : 'a letter';
  const where = c.ref.startsWith('ARCH-') ? ' as a business' : c.why === 'this application' ? '' : ` about ${esc(c.ref)}`;
  const lock = isLocked(c) ? ` <b>&#128274; Locked until ${esc(prettyDate(lockedUntil(c.date)))}</b> (6-month rule).` : c.date ? ` Over 6 months ago, so you can send again if you mean to.` : '';
  return `${who} was sent ${what}${where} on ${esc(prettyDate(c.date))}${c.why === 'same address' || c.why === 'same house' ? ' (same house)' : ''}.${lock}`;
}
// Other letters waiting in the folders for the same house or person (not yet on the print list).
function waitingTwins(l){
  if (l.alreadyProcessed || !leads.includes(l)) return [];
  const bz = x => (x.ref || '').startsWith('ARCH-') || leadFolder(x) === 'business';
  const h = bz(l) ? [] : houseKeys(l.recipientLines), n = personNorm(l.applicant);
  return leads.filter(o => o !== l && !o.alreadyProcessed && !o.include && (sameHouse(h, bz(o) ? [] : houseKeys(o.recipientLines)) || samePerson(n, personNorm(o.applicant))));
}
function contactFlagHtml(l){
  const enq = (typeof enquiryFlagHtml === 'function' ? enquiryFlagHtml({ ref: l.baseRef || l.ref, name: l.applicant, address: (l.recipientLines || []).slice(1).join(', ') + ' ' + (l.site || '') }) : '')
    + (() => { const t = waitingTwins(l); return t.length ? `<div class="contact-flag"><b>&#9888; ${t.length + 1} letters waiting for this house.</b> Also: ${t.map(o => `${esc(o.ref)} in ${esc(FOLDERS[leadFolder(o)])}`).join(', ')}. Send one and archive the rest (the print step won't let two go).</div>` : ''; })();
  const p = priorContacts(l).filter(c => !(c.why === 'this application' && l.alreadyProcessed));
  if (!p.length) return enq;
  return enq + `<div class="contact-flag"><b>&#9888; Already written to.</b> ${p.slice(0, 3).map(contactLine).join(' ')}${p.length > 3 ? ` And ${p.length - 3} more.` : ''}</div>`;
}

// The one question before anything is sent twice. True = go ahead.
function confirmRepeats(list, action){
  if (typeof confirmEnquiries === 'function' && !confirmEnquiries(list, action)) return false;
  const toPrint = /print list/i.test(action);   // settleTwins() sorts out two of the same house going to print, so don't nag about that here
  const hits = list.map(l => ({ l, p: priorContacts(l).filter(c => !(c.why === 'this application' && l.alreadyProcessed) && !(toPrint && c.why === 'also on the print list')) })).filter(x => x.p.length);
  if (!hits.length) return true;
  // Prime directive: nobody gets a second letter within 6 months, and no house gets two letters in one batch.
  const locked = hits.filter(x => x.p.some(c => isLocked(c) || c.why === 'also on the print list'));
  if (locked.length) {
    const why = x => { const c = x.p.find(c => isLocked(c)) || x.p[0];
      return c.why === 'also on the print list' ? `${x.l.applicant}: the same house or person as ${c.name}, both in this batch. Keep one.`
        : `${x.l.applicant}: ${c.why}, written to ${prettyDate(c.date)} (${c.name}). Locked until ${prettyDate(lockedUntil(c.date))}.`; };
    return confirm(`${locked.length === 1 ? 'This letter breaks' : `${locked.length} of these letters break`} the one-letter-per-household rule:\n\n${locked.slice(0, 10).map(x => '- ' + why(x)).join('\n')}${locked.length > 10 ? `\n...and ${locked.length - 10} more` : ''}\n\nOverride and carry on anyway? (Cancel is the safe answer.)`);
  }
  const lines = hits.slice(0, 8).map(x => `- ${x.l.applicant}: ${x.p[0].why === 'also on the print list' ? 'also on the print list' : `${x.p[0].why}, sent ${prettyDate(x.p[0].date)}`}`);
  return confirm(`You've already written to ${hits.length === 1 ? 'this person' : `${hits.length} of these people`}:\n\n${lines.join('\n')}${hits.length > 8 ? `\n...and ${hits.length - 8} more` : ''}\n\n${action} anyway?`);
}

// ---- Where each person stands ----
function contactCategory(ref, e){
  if (ref.startsWith('ARCH-') || (e && e.source === 'business')) return 'business';
  return (e && e.copy) || 'approved';
}
function statusOf(ref){
  const sent = getLog()[ref], lead = leads.find(l => l.ref === ref), arch = getDismissed()[ref];
  if (sent) return { key: 'sent', text: `Printed & sent ${prettyDate(sent.date)}` };
  if (lead && lead.include) return { key: 'print', text: `On the print list${lead.sentToPrintAt ? ' since ' + prettyDate(lead.sentToPrintAt) : ''}` };
  if (lead) return { key: 'waiting', text: `Waiting in ${FOLDERS[leadFolder(lead)]}` };
  if (arch) return { key: 'archived', text: `Not chasing, since ${prettyDate(arch.date)}` };
  return { key: 'none', text: 'Not contacted' };
}
const statusTagHtml = ref => { const s = statusOf(ref); return `<span class="status-tag ${s.key}">${esc(s.text)}</span>`; };
const nameBtn = (ref, name) => `<button type="button" class="prof-name" data-profile="${esc(ref)}" title="Everything about them">${esc(name)}</button>`;

// Has this person or firm been written to, or are they already in Businesses? (who's-involved line)
function partyStatus(name, company){
  const n = personNorm(name), co = personNorm(company || '');
  const sent = sentContacts().find(c => (n && samePerson(n, c.n)) || (co && co.length > 3 && (c.n === co || personNorm((c.lines || [])[1] || '') === co)));
  if (sent) return { kind: 'sent', text: `Written to ${prettyDate(sent.e.date)}`, ref: sent.ref };
  const lead = leads.find(l => (n && samePerson(n, personNorm(l.applicant))) || (co && co.length > 3 && personNorm((l.recipientLines || [])[1] || '') === co));
  if (lead) return { kind: 'lead', text: lead.include ? 'On the print list' : `In ${FOLDERS[leadFolder(lead)]}`, ref: lead.ref };
  return null;
}
// "+ Add as business" for anyone named on an application: agent, architect, engineer, builder.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-add-biz]');
  if (!b || typeof addBusinessLead !== 'function') return;
  e.preventDefault();
  const name = b.dataset.addBiz, company = b.dataset.company || '', role = b.dataset.role || '';
  const ref = 'ARCH-' + slugify(name + '-' + company);
  const ok = addBusinessLead({ ref, name, company, address: b.dataset.address || '', description: `${role ? role[0].toUpperCase() + role.slice(1) : 'Named'} on ${b.dataset.app || 'a planning application'}` });
  const lead = leads.find(l => l.ref === ref);
  if (ok && lead) {
    lead.trade = { architect: 'Architect', engineer: 'Engineer', builder: 'Builder' }[role] || guessTrade(`${name} ${company}`) || 'Planning agent';
    if (!b.dataset.address) { lead.needsReview = true; lead.extraReviewNote = 'No address yet: Google them and add it before sending.'; lead.reviewNote = lead.extraReviewNote; }
    saveLeadsToStorage();
  }
  b.outerHTML = `<span class="tag tag-approved">${ok ? 'Added to Businesses' : 'Already in Businesses, sent or not chasing'}</span>`;
});

// ---- Business trades ----
const TRADES = ['Architect', 'Engineer', 'Planning agent', 'Surveyor', 'Builder', 'Groundworks', 'Electrician', 'Plumber',
  'Painter & decorator', 'Roofer', 'Joiner', 'Landscaper', 'Estate agent', 'Advocate', 'Accountant', 'Other'];
function guessTrade(text){
  const t = (text || '').toLowerCase();
  if (/architect/.test(t)) return 'Architect';
  if (/engineer|structural|civil/.test(t)) return 'Engineer';
  if (/survey/.test(t)) return 'Surveyor';
  if (/advocate|solicitor|\blaw\b|legal/.test(t)) return 'Advocate';
  if (/estate agent|lettings|property services/.test(t)) return 'Estate agent';
  if (/builder|construction|contractor|building/.test(t)) return 'Builder';
  if (/planning|design|consult|associates/.test(t)) return 'Planning agent';
  return '';
}
function tradeOf(l){
  if (!l) return '';
  if (l.trade) return l.trade;
  if (/^Agent on /.test(l.description || '')) return guessTrade(`${l.applicant} ${l.site || ''} ${(l.recipientLines || []).join(' ')}`) || 'Planning agent';
  return 'Architect';   // the first business list was the Isle of Man architects register
}

// ---- "People you've messaged" (print page) ----
function contactedBarHtml(batch){
  const list = sentContacts().slice().sort((x, y) => (y.e.date || '').localeCompare(x.e.date || ''));
  batch = batch || [];
  const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const planning = (ref, e) => {
    const t = typeof timings !== 'undefined' && timings ? timings.byRef.get(ref) : null;   // older letters didn't record dates
    if (e && e.decidedDate) return `Decided ${esc(e.decidedDate)}`;
    if (t && t.decided) return `Decided ${fmt(t.decided)}`;
    if (e && e.appliedDate) return `Applied ${esc(e.appliedDate)}`;
    return t && t.received ? `Applied ${fmt(t.received)}` : '';
  };
  const value = (ref, description) => {
    if (ref.startsWith('ARCH-') || typeof estimateFor !== 'function') return '';
    const est = estimateFor(ref, typeof parentRefOf === 'function' ? parentRefOf({ ref, description: description || '' }) : null);
    return est ? `Job ${moneyRange(est.total)}${est.groundworks ? `<br><span class="hint" style="margin:0">Groundworks ${moneyRange(est.groundworks)}</span>` : ''}` : '';
  };
  const kind = (ref, copy, lead) => ref.startsWith('ARCH-') ? `Business &middot; ${esc(tradeOf(lead || leads.find(l => l.ref === ref)) || 'business')}` : `${esc(FOLDERS[copy] || 'Planning')} letter`;
  const onList = batch.map(l => {
    const p = priorContacts(l).filter(c => c.why !== 'this application');
    return `<tr><td>${nameBtn(l.ref, l.applicant)}<br><span class="hint" style="margin:0">${kind(l.ref, leadFolder(l), l)}</span></td>
      <td>${planning(l.ref, l)}</td><td>${value(l.ref, l.description)}</td>
      <td class="${p.length ? 'rep' : ''}">${p.length ? `Yes: ${esc(p[0].why)}, ${p[0].date ? esc(prettyDate(p[0].date)) : 'on this list'}` : 'No, first letter'}</td>
      <td>Not yet</td><td>${l.sentToPrintAt ? esc(prettyDate(l.sentToPrintAt)) : ''}</td></tr>`;
  }).join('');
  const done = list.map(c => {
    const again = list.filter(o => o !== c && ((c.n && samePerson(c.n, o.n)) || (c.a && c.a === o.a)));
    return `<tr><td>${nameBtn(c.ref, c.name)}<br><span class="hint" style="margin:0">${kind(c.ref, c.e.copy)}</span></td>
      <td>${planning(c.ref, c.e)}</td><td>${value(c.ref, c.e.description)}</td>
      <td class="${again.length ? 'rep' : ''}">${again.length ? `Yes, ${again.length + 1} letters in total` : 'No'}</td>
      <td>${esc(prettyDate(c.e.date))}</td><td>${c.e.sentToPrintAt ? esc(prettyDate(c.e.sentToPrintAt)) : '<span class="hint" style="margin:0">not recorded</span>'}</td></tr>`;
  }).join('');
  const repeats = batch.filter(l => priorContacts(l).some(c => c.why !== 'this application'));
  return `<details class="contacted-bar"${repeats.length ? ' open' : ''}>
    <summary>People you've messaged (${list.length} sent${batch.length ? `, ${batch.length} on this print list` : ''})${repeats.length ? ` &middot; &#9888; ${repeats.length} on this list were written to before` : ''}</summary>
    ${repeats.length ? `<div class="contacted-warn">&#9888; Written to before and on this list: ${repeats.map(l => esc(l.applicant)).join(', ')}. Take them off, or you'll be asked before anything prints.</div>` : ''}
    <table class="contacted">
      <tr><th>Name</th><th>Date of planning</th><th>Estimated value</th><th>Written to before?</th><th>Letter printed &amp; sent</th><th>Sent to print</th></tr>
      ${onList ? `<tr class="grp"><td colspan="6">On this print list now</td></tr>${onList}` : ''}
      ${done ? `<tr class="grp"><td colspan="6">Already printed and sent</td></tr>${done}` : '<tr><td colspan="6" class="hint">Nobody has been sent a letter yet.</td></tr>'}
    </table>
    <p class="hint" style="margin:8px 0 0">Click any name for everything about them.</p>
  </details>`;
}

// ---- Profile: everything about one person ----
let REG_APPS = null;
function registerApps(){
  if (!REG_APPS) REG_APPS = privateJson(REGISTER_DATA_URL, REGISTER_DATA_URL)
    .then(d => new Map((d.applications || []).map(a => [a.ref, a]))).catch(() => new Map());
  return REG_APPS;
}
const googleLink = (q, label) => `<a class="btn-secondary" style="text-decoration:none;padding:3px 9px" target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent(q)}">&#128269; ${esc(label)}</a>`;

async function openProfile(ref){
  const [apps] = await Promise.all([registerApps(), typeof loadTimings === 'function' ? loadTimings() : null,
                                    typeof loadRelatedIndex === 'function' ? loadRelatedIndex() : null]);
  const lead = leads.find(l => l.ref === ref);
  const sent = getLog()[ref];
  const arch = getDismissed()[ref];
  const archLead = arch && arch.lead;
  const isBiz = ref.startsWith('ARCH-');
  const rec = typeof relIdx !== 'undefined' && relIdx ? relIdx.rec.get(ref) : null;
  const t = typeof timings !== 'undefined' && timings ? timings.byRef.get(ref) : null;
  const fmt = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const a = apps.get(ref) || (rec ? { ref, description: rec.description, address: rec.address, keyVal: rec.keyVal,
    received: fmt(rec.received), decision: rec.decision, decisionDate: t && t.decided ? fmt(t.decided) : '', isDecided: !!(t && t.decided),
    agentName: t && t.agent } : null);
  const src = lead || archLead || {};
  const name = src.applicant || (sent && sent.name) || (arch && arch.name) || (a && (a.applicantName || a.agentCompanyName)) || ref;
  const lines = src.recipientLines || (sent && sent.recipientLines) || [];
  const s = statusOf(ref);
  const sections = [];

  // Where they stand and every letter to them
  const pseudo = { ref, applicant: name, recipientLines: lines.length ? lines : [name, ...((a && a.address) || '').split(',')],
                   agentText: src.agentText || (a ? `${a.agentName || ''} ${a.agentCompanyName || ''}` : '') };
  const history = priorContacts(pseudo);
  sections.push(`<h3>Contact</h3>
    <div>${statusTagHtml(ref)}${sent && sent.pdfFile ? ` <span class="hint" style="margin:0 0 0 6px">PDF: ${esc(sent.pdfFile)}${sent.pdfPage ? `, page ${sent.pdfPage}` : ''}</span>` : ''}</div>
    ${src.visitedAt || (sent && sent.visitedAt) ? `<div class="hint" style="margin:6px 0 0">Visited ${esc(prettyDate(src.visitedAt || sent.visitedAt))}</div>` : ''}
    ${history.length ? `<ul class="prof-apps">${history.map(c => `<li>${contactLine(c)}</li>`).join('')}</ul>` : '<div class="hint" style="margin:6px 0 0">No letters to them or their household yet.</div>'}
    ${lines.length ? `<div class="hint" style="margin:8px 0 0">Letter address: ${lines.map(esc).join(', ')}</div>` : ''}`);

  if (isBiz) {
    const trade = tradeOf(src);
    const agentApps = (typeof timings !== 'undefined' && timings ? timings.rows.filter(r => r.agent && (samePerson(personNorm(r.agent), personNorm(name)) || personNorm(r.agent) === personNorm(lines[1] || ''))) : []);
    agentApps.sort((x, y) => (y.received || 0) - (x.received || 0));
    sections.push(`<h3>Business</h3>
      <div><b>${esc(trade || 'Business')}</b>${lines[1] ? ` &middot; ${esc(lines[1])}` : ''}</div>
      <div class="hint" style="margin:4px 0 0">${/^Agent on /.test(src.description || '') ? esc(src.description) : 'From the Isle of Man architects register list.'}</div>
      ${agentApps.length ? `<div style="margin-top:8px"><b>${agentApps.length} planning application${agentApps.length === 1 ? '' : 's'} with them as agent</b> (newest first):</div>
        <ul class="prof-apps">${agentApps.slice(0, 12).map(r => {
          const d = typeof relIdx !== 'undefined' && relIdx ? relIdx.rec.get(r.ref) : null;
          const est = typeof estimateFor === 'function' ? estimateFor(r.ref, null) : null;
          return `<li>${nameBtn(r.ref, r.ref)} &middot; ${esc(fmt(r.received))}${est ? ` &middot; job ${moneyRange(est.total)}` : ''}${d && d.description ? ` &middot; ${esc(d.description.slice(0, 140))}` : ''}</li>`;
        }).join('')}</ul>` : ''}`);
  }

  if (a) {
    const parent = typeof parentRefOf === 'function' ? parentRefOf(a) : null;
    sections.push(`<h3>The application</h3>
      <div><b>${esc(a.ref)}</b> &middot; ${esc(a.address || '')}${a.parish ? ` &middot; ${esc(a.parish)}` : ''}</div>
      <div class="reg-work" style="margin-top:8px"><span class="lbl">Applying for</span>${typeof whatThisIsHtml === 'function' ? whatThisIsHtml(a) : esc(a.description || '')}</div>
      ${typeof whoInvolvedHtml === 'function' ? whoInvolvedHtml(a) : ''}
      <div class="lr-meta">Applied ${esc(a.received || '?')}${a.isDecided && a.decisionDate ? ` &middot; ${esc(a.decision || 'Decided')} ${esc(a.decisionDate)}` : ' &middot; not decided yet'}</div>
      ${a.applicantName ? `<div class="hint" style="margin:6px 0 0">Applicant: ${esc(a.applicantName)}</div>` : ''}
      ${a.agentName || a.agentCompanyName ? `<div class="hint" style="margin:4px 0 0">Agent: ${esc(a.agentName || '')}${a.agentCompanyName ? ` (${esc(a.agentCompanyName)})` : ''}${a.agentAddress ? `, ${esc(a.agentAddress)}` : ''}</div>` : ''}
      <h3>Estimate</h3>
      ${typeof estimateRowHtml === 'function' ? estimateRowHtml(a.ref, parent, typeof originalLineHtml === 'function' ? originalLineHtml(parent, a) : '') : ''}
      ${typeof relatedListHtml === 'function' && relIdx ? relatedListHtml(a) : ''}`);
  }

  const links = [googleLink(`${name} Isle of Man`, 'Google them')];
  if (a && (a.agentName || a.agentCompanyName)) links.push(googleLink(`${a.agentCompanyName || a.agentName} Isle of Man`, 'Google the agent'));
  if (isBiz && lines[1]) links.push(googleLink(`${lines[1]} Isle of Man`, 'Google the business'));
  if (a && a.keyVal && typeof drawingsLinkHtml === 'function') links.push(drawingsLinkHtml(a.keyVal));

  // The letter: exactly what went out, or what would go out
  const snap = sent && (sent.recipientLines || lead) ? { recipientLines: sent.recipientLines || lead.recipientLines, salutation: sent.salutation || (lead && lead.salutation) || '',
    folder: sent.copy || contactCategory(ref, sent), letterDate: sent.letterDate || null, bodyParas: sent.bodyParas || null } : null;
  const letter = snap ? letterHtml(snap) : lead ? letterHtml(lead) : '';
  if (letter) sections.push(`<h3>${snap ? 'The letter that was sent' : 'The letter that would be sent'}</h3><div class="letter-preview">${letter}</div>`);

  const box = document.createElement('div');
  box.className = 'prof-overlay';
  box.innerHTML = `<div class="prof-panel" role="dialog" aria-label="${esc(name)}">
    <button type="button" class="prof-close" title="Close">&times;</button>
    <h2>${esc(name)}${isBiz ? `<span class="trade-tag">${esc(tradeOf(src) || 'Business')}</span>` : ''}</h2>
    <div class="hint" style="margin:0">${isBiz ? 'Business' : lead ? `${esc(FOLDERS[leadFolder(lead)])} folder` : sent ? `${esc(FOLDERS[sent.copy] || 'Planning')} letter` : 'Planning application'} &middot; ${esc(ref)}</div>
    <div class="prof-links">${links.join('')}</div>
    ${sections.join('')}
  </div>`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', e => { if (e.target === box || e.target.classList.contains('prof-close')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}
// Any name marked data-profile opens the profile (nested profiles replace the open one).
document.addEventListener('click', e => {
  const el = e.target.closest('[data-profile]');
  if (!el) return;
  e.preventDefault();
  document.querySelectorAll('.prof-overlay').forEach(o => o.remove());
  openProfile(el.dataset.profile);
});

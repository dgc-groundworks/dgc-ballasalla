// Silverdale Canvassing: "have we written to this person before?"
// A fail-safe so nobody gets a second letter by accident (Ash, 26 Sep 2026):
// every folder row and every letter on the print list is checked against the
// sent record by name, by address and (for planning leads) by their agent, and
// sending a repeat always asks first. Also the "People you've messaged" list.
// Depends on index.html for: getLog, LS_LOG, leads, leadFolder, FOLDERS, esc,
// prettyDate, todayISO, parentRefOf; and on market.js for estimateFor, moneyRange.

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
  .contacted-warn{color:#ef4444;font-weight:700;margin:8px 0 0;font-size:0.85rem}
  `;
  const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
})();

function personNorm(name){
  if (/on (the )?register|not legible|illegible|unclear|not stated/i.test(name || '')) return '';   // placeholders, not people
  return (name || '').toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/\b(mr|mrs|ms|miss|dr|prof|sir|and|the|ltd|limited|plc|llp)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function postcodeOf(lines){
  const m = (lines || []).join(' ').match(/\bIM\d{1,2}\s?\d[A-Z]{2}\b/i);
  return m ? m[0].toUpperCase().replace(/\s+/g, '') : '';
}
// First address line plus postcode, so a household matches whichever name is on the letter.
function addrKey(lines){
  const pc = postcodeOf(lines), first = ((lines || [])[1] || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return pc && first ? first + '|' + pc : '';
}

// The sent record as a list, rebuilt only when it changes.
const CONTACTS = { raw: null, list: [] };
function sentContacts(){
  const raw = localStorage.getItem(LS_LOG) || '{}';
  if (raw !== CONTACTS.raw) {
    const log = getLog();
    CONTACTS.list = Object.entries(log).map(([ref, e]) => {
      const lines = e.recipientLines || [];
      const name = e.name || lines[0] || '';
      return { ref, e, name, lines, n: personNorm(name), a: addrKey(lines) };
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
  const agent = personNorm(l.agentText || '');
  const out = [];
  sentContacts().forEach(c => {
    const why = c.ref === l.ref ? 'this application'
      : n && c.n && n === c.n ? 'same name'
      : a && a === c.a ? 'same address'
      : agent && c.n.length > 4 && agent.includes(c.n) ? 'their agent'
      : null;
    if (why) out.push({ ref: c.ref, name: c.name, date: c.e.date, copy: c.e.copy, why });
  });
  leads.forEach(o => {
    if (o === l || !o.include || o.alreadyProcessed) return;
    const on = personNorm(o.applicant);
    if ((n && on === n) || (a && addrKey(o.recipientLines) === a)) out.push({ ref: o.ref, name: o.applicant, date: null, copy: leadFolder(o), why: 'also on the print list' });
  });
  return out.sort((x, y) => (y.date || '9').localeCompare(x.date || '9'));
}

function contactLine(c){
  const who = c.why === 'their agent' ? `Their agent, ${esc(c.name)},` : esc(c.name);
  if (c.why === 'also on the print list') return `${who} is also on the print list right now (${esc(c.ref)}).`;
  const what = FOLDERS[c.copy] ? `the ${esc(FOLDERS[c.copy])} letter` : 'a letter';
  const where = c.ref.startsWith('ARCH-') ? ' as a business' : c.why === 'this application' ? '' : ` about ${esc(c.ref)}`;
  return `${who} was sent ${what}${where} on ${esc(prettyDate(c.date))}${c.why === 'same address' ? ' (same address)' : ''}.`;
}
function contactFlagHtml(l){
  const p = priorContacts(l);
  if (!p.length) return '';
  return `<div class="contact-flag"><b>&#9888; Already written to.</b> ${p.slice(0, 3).map(contactLine).join(' ')}${p.length > 3 ? ` And ${p.length - 3} more.` : ''}</div>`;
}

// The one question before anything is sent twice. True = go ahead.
function confirmRepeats(list, action){
  const hits = list.map(l => ({ l, p: priorContacts(l) })).filter(x => x.p.length);
  if (!hits.length) return true;
  const lines = hits.slice(0, 8).map(x => `- ${x.l.applicant}: ${x.p[0].why === 'also on the print list' ? 'also on the print list' : `${x.p[0].why}, sent ${prettyDate(x.p[0].date)}`}`);
  return confirm(`You've already written to ${hits.length === 1 ? 'this person' : `${hits.length} of these people`}:\n\n${lines.join('\n')}${hits.length > 8 ? `\n...and ${hits.length - 8} more` : ''}\n\n${action} anyway?`);
}

// "People you've messaged": every letter sent, newest first.
function contactedBarHtml(batch){
  const list = sentContacts().slice().sort((x, y) => (y.e.date || '').localeCompare(x.e.date || ''));
  const repeatsInBatch = (batch || []).filter(l => priorContacts(l).length);
  const byPerson = new Map();
  list.forEach(c => { const k = c.n || c.a || c.ref; byPerson.set(k, (byPerson.get(k) || 0) + 1); });
  const day = iso => iso ? prettyDate(iso) : '';
  const planning = e => e.decidedDate ? `Decided ${esc(e.decidedDate)}` : e.appliedDate ? `Applied ${esc(e.appliedDate)}` : '';
  const value = c => {
    if (c.ref.startsWith('ARCH-') || typeof estimateFor !== 'function') return '';
    const est = estimateFor(c.ref, typeof parentRefOf === 'function' ? parentRefOf({ ref: c.ref, description: c.e.description || '' }) : null);
    return est ? `Job ${moneyRange(est.total)}${est.groundworks ? `<br><span class="hint" style="margin:0">Groundworks ${moneyRange(est.groundworks)}</span>` : ''}` : '';
  };
  return `<details class="contacted-bar"${repeatsInBatch.length ? ' open' : ''}>
    <summary>People you've messaged (${list.length})${repeatsInBatch.length ? ` &middot; ${repeatsInBatch.length} on this list already written to` : ''}</summary>
    ${repeatsInBatch.length ? `<div class="contacted-warn">&#9888; Already written to, and on this list: ${repeatsInBatch.map(l => esc(l.applicant)).join(', ')}. Take them off, or you'll be asked before anything prints.</div>` : ''}
    ${list.length ? `<table class="contacted">
      <tr><th>Name</th><th>Planning</th><th>Estimated value</th><th>Written to before</th><th>Letter sent</th><th>Sent to print</th></tr>
      ${list.map(c => {
        const times = byPerson.get(c.n || c.a || c.ref) || 1;
        return `<tr><td><b>${esc(c.name)}</b><br><span class="hint" style="margin:0">${esc(c.ref.startsWith('ARCH-') ? 'Business' : c.ref)} &middot; ${esc(FOLDERS[c.e.copy] || '')} letter</span></td>
          <td>${planning(c.e)}</td><td>${value(c)}</td>
          <td class="${times > 1 ? 'rep' : ''}">${times > 1 ? `Yes, ${times} letters` : 'No, just this one'}</td>
          <td>${day(c.e.date)}</td><td>${day(c.e.sentToPrintAt) || '<span class="hint" style="margin:0">not recorded</span>'}</td></tr>`;
      }).join('')}
    </table>` : '<p class="hint">Nobody has been sent a letter yet.</p>'}
  </details>`;
}

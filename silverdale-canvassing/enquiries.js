// ---- Responses: people who have contacted us (28 Sep 2026) ----
// Every contact form on the Silverdale, Manx Drain and DGC websites, plus enquiries found in the
// mailboxes, lands in the canvass_enquiries table (see enquiries-setup.sql). Here each one is matched
// against the planning register, the letters sent and the folders, so nobody who has already
// contacted us is sent a canvassing letter, and every enquiry shows its planning history and value.

const ENQ = { rows: [], loaded: false, loading: null, index: null, showHidden: false };
const ENQ_SITE = { silverdale: 'Silverdale', manx: 'Manx Drain Solutions', dgc: 'DGC' };
const STATS_URL = 'https://dgc-ltd.github.io/dgc-traffic-dashboard/';

async function loadEnquiries(force){
  if (ENQ.loading && !force) return ENQ.loading;
  ENQ.loading = (async () => {
    try {
      const r = await cloudFetch('/rest/v1/canvass_enquiries?select=*&order=received_at.desc');
      if (!r.ok) throw new Error('enquiries ' + r.status);
      ENQ.rows = (await r.json()).map(normaliseEnquiry);
      ENQ.loaded = true;
    } catch (e) { ENQ.error = e.message; }
    ENQ.loading = null;
  })();
  return ENQ.loading;
}
// Check for new enquiries once signed in, then every 5 minutes.
(function pollEnquiries(){
  const tick = () => {
    if (typeof cloud === 'undefined' || !cloud.on) return;
    const before = ENQ.rows.length;
    loadEnquiries(true).then(() => buildEnquiryIndex()).then(() => { if (ENQ.rows.length !== before && state.tab !== 'responses') render(); else updateEnquiryCount(); });
  };
  const wait = setInterval(() => { if (typeof cloud !== 'undefined' && cloud.on) { clearInterval(wait); tick(); setInterval(tick, 5 * 60 * 1000); } }, 1000);
})();

// ---- Reading an enquiry, whatever shape the form sent it in ----
function enqPick(e, re){
  for (const src of [e.payload.fields, e.payload.data, e.payload.human_fields, e.payload]) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) if (re.test(k) && v && typeof v !== 'object') return String(v).trim();
  }
  return '';
}
function normaliseEnquiry(row){
  const e = { id: row.id, site: row.site, via: row.via, payload: row.payload || {}, notes: row.notes || {}, received: row.payload && (row.payload.received || row.payload.created_at) || row.received_at };
  const first = enqPick(e, /^(first[ _-]?name|firstname|name|from_name|full[ _-]?name)$/i);
  const last = enqPick(e, /^(last[ _-]?name|lastname|surname)$/i);
  e.name = [first, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || enqPick(e, /name/i) || '(no name)';
  e.email = enqPick(e, /^(email|email address|_replyto|from_email|e-mail)$/i) || enqPick(e, /mail/i);
  e.phone = enqPick(e, /phone|tel|mobile/i);
  e.message = enqPick(e, /^(message|enquiry|details|your message|comments?)$/i) || enqPick(e, /message|enquiry/i);
  e.service = enqPick(e, /service/i);
  e.addressText = enqPick(e, /address(?!.*mail)/i);
  e.page = e.payload.page || e.payload.site_url || '';
  e.ip = e.payload.ip || '';
  e.test = !!e.notes.test || /^test\b/i.test(e.name) && /test only/i.test(e.message);
  e.junk = !!e.notes.junk;
  e.keys = addrKeysOf(`${e.addressText} ${e.message}`);
  e.postcode = ((`${e.addressText} ${e.message}`).match(/\bIM\d{1,2}\s?\d[A-Z]{2}\b/i) || [''])[0].toUpperCase().replace(/\s+/g, '');
  e.n = personNorm(e.name);
  return e;
}

// "18 Governors Road Onchan" -> "18|governors road"; the same key comes out of a register address.
const STREET_WORDS = 'road|rd|street|st|avenue|ave|lane|close|drive|crescent|way|park|place|terrace|grove|gardens|view|hill|court|mews|walk|rise|green|brow|heights|meadows|fields|square|parade|row|vale|glen|estate|promenade|hey|brae|croft';
const ADDR_RE = new RegExp(`\\b(\\d{1,4}[a-z]?)\\s*,?\\s+((?:[a-z'-]+\\s+){0,3}?(?:${STREET_WORDS}))\\b`, 'gi');
function addrKeysOf(text){
  const out = new Set();
  const t = (text || '').replace(/\s+/g, ' ');
  for (const m of t.matchAll(ADDR_RE)) {
    const street = m[2].toLowerCase().replace(/\brd\b/g, 'road').replace(/\bst\b/g, 'street').replace(/\bave\b/g, 'avenue').trim();
    out.add(m[1].toLowerCase() + '|' + street);
  }
  return [...out];
}

// ---- Matching against the planning register and our letters ----
async function buildEnquiryIndex(){
  if (ENQ.index) return ENQ.index;
  const [det, reg] = await Promise.all([loadDetails(), privateJson(REGISTER_DATA_URL, REGISTER_DATA_URL).catch(() => ({}))]);
  const byKey = new Map(), apps = new Map();
  const add = (ref, a) => {
    if (!apps.has(ref)) apps.set(ref, a); else Object.assign(apps.get(ref), Object.fromEntries(Object.entries(a).filter(([, v]) => v)));
    addrKeysOf(a.address).forEach(k => { if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(ref); });
  };
  Object.entries((det && det.apps) || {}).forEach(([ref, x]) => add(ref, { ref, description: x[0] || '', address: x[1] || '', keyVal: x[2] || '', agentName: x[3] || '', agentCompanyName: x[4] || '', agentAddress: x[5] || '', applicantName: x[6] || '', decision: x[7] || '' }));
  ((reg && reg.applications) || []).forEach(a => add(a.ref, { ref: a.ref, description: a.description || '', address: a.address || '', keyVal: a.keyVal || '', agentName: a.agentName || '', agentCompanyName: a.agentCompanyName || '', agentAddress: a.agentAddress || '', applicantName: a.applicantName || '', decision: a.decision || a.status || '', received: a.received || '', decisionDate: a.decisionDate || '', isDecided: !!a.isDecided, parish: a.parish || '' }));
  ENQ.index = { byKey, apps };
  return ENQ.index;
}
// Planning applications at the address in an enquiry, newest first.
function planningFor(e){
  if (!ENQ.index) return [];
  const refs = new Set();
  e.keys.forEach(k => (ENQ.index.byKey.get(k) || []).forEach(r => refs.add(r)));
  return [...refs].map(r => ENQ.index.apps.get(r)).filter(Boolean).sort((a, b) => b.ref.localeCompare(a.ref));
}
// Does this person, address or application belong to someone who has contacted us?
// x = { ref, name, address } from a register row or a lead. Strong = same house; medium = same full name.
function enquiryMatch(x){
  if (!ENQ.rows.length) return null;
  const keys = addrKeysOf(x.address || '');
  const n = personNorm(x.name || '');
  let best = null;
  for (const e of ENQ.rows) {
    if (e.test || e.junk) continue;
    let why = null;
    if (x.ref && planningFor(e).some(a => a.ref === x.ref)) why = 'same address';
    else if (keys.length && e.keys.some(k => keys.includes(k))) why = 'same address';
    else if (n && e.n && samePerson(n, e.n)) why = 'same name';
    if (why && (!best || (why === 'same address' && best.why !== 'same address'))) best = { e, why };
  }
  return best;
}
const enqWhen = e => { const d = new Date(e.received); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const enqWhenTime = e => { const d = new Date(e.received); return isNaN(d) ? '' : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
function enquiryLine(m){
  const e = m.e;
  return `${esc(e.name)} contacted ${esc(ENQ_SITE[e.site] || e.site)} on ${esc(enqWhen(e))} (${esc(e.via)})${m.why === 'same name' ? ', matched on their name' : ''}.`;
}
// The red box on a register row or a lead: never write to someone who has already come to us.
function enquiryFlagHtml(x){
  const m = enquiryMatch(x);
  if (!m) return '';
  return `<div class="contact-flag enq-flag"><b>&#9742; Contacted us.</b> ${enquiryLine(m)} Don't send a canvassing letter. <button type="button" class="btn-secondary enq-open" data-enq="${m.e.id}" style="padding:1px 7px;font-size:0.7rem">See their enquiry</button></div>`;
}
function enquiryTagHtml(x){
  const m = enquiryMatch(x);
  return m ? `<span class="tag tag-enq" title="${esc(plainText(enquiryLine(m)))}">&#9742; Contacted us &middot; ${esc(enqWhen(m.e))}</span>` : '';
}
// Asked before anything goes on the print list. True = go ahead.
function confirmEnquiries(list, action){
  const hits = list.map(l => ({ l, m: enquiryMatch({ ref: l.baseRef || l.ref, name: l.applicant, address: (l.recipientLines || []).slice(1).join(', ') + ' ' + (l.site || '') }) })).filter(x => x.m);
  if (!hits.length) return true;
  const lines = hits.slice(0, 8).map(x => `- ${x.l.applicant}: ${plainText(enquiryLine(x.m))}`);
  return confirm(`${hits.length === 1 ? 'This person has' : `${hits.length} of these people have`} already contacted us, so they don't need a canvassing letter:\n\n${lines.join('\n')}\n\n${action} anyway?`);
}
document.addEventListener('click', e => {
  const b = e.target.closest('.enq-open');
  if (!b) return;
  e.preventDefault();
  state.tab = 'responses'; ENQ.focus = Number(b.dataset.enq); render();
});

// ---- Rough value when there's no planning application: similar jobs the estimator has priced ----
const JOB_WORDS = [
  ['conservatory', /conservator|sun ?room|orangery/i], ['extension', /extension|extend/i], ['kitchen', /kitchen/i],
  ['garage', /garage/i], ['dormer or loft', /dormer|loft/i], ['new house', /new (house|home|build|dwelling)|erection of (a )?dwelling/i],
  ['driveway', /drive ?way|parking|hardstanding/i], ['drainage', /drain|sewer|septic|soakaway/i], ['patio or garden', /patio|decking|garden|landscap/i],
  ['bathroom', /bathroom|shower/i], ['renovation', /renovat|refurb|alteration/i]];
function roughValueFor(e){
  if (typeof MARKET === 'undefined' || !MARKET.estimates.size || !ENQ.index) return null;
  const want = JOB_WORDS.filter(([, re]) => re.test(`${e.message} ${e.service}`));
  if (!want.length) return null;
  const words = want.map(w => w[0]);
  const core = want.find(w => w[0] === 'conservatory') || want[0];
  // Leave out big schemes (two storeys, new dwellings, flats) unless the enquiry is for one.
  const BIG = /two[- ]storey|first floor|second floor|dwelling|apartment|flats|units|demolition of (the )?(existing )?(house|dwelling)/i;
  const big = words.includes('new house') || /two[- ]storey|first floor/i.test(e.message);
  const pool = [...MARKET.estimates.values()].filter(x => {
    const a = x.total && ENQ.index.apps.get(x.ref);
    return a && core[1].test(a.description) && (big || !BIG.test(a.description));
  });
  const mids = pool.map(x => midOf(x.total)).filter(v => v > 0).sort((a, b) => a - b);
  if (mids.length < 2) return null;
  const gw = pool.map(x => x.groundworks ? midOf(x.groundworks) : null).filter(v => v > 0).sort((a, b) => a - b);
  const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
  return { words, n: mids.length, low: q(mids, 0.25), mid: q(mids, 0.5), high: q(mids, 0.75), gw: gw.length ? q(gw, 0.5) : null,
    examples: pool.slice(0, 3).map(x => ({ ref: x.ref, desc: ENQ.index.apps.get(x.ref).description, mid: midOf(x.total) })) };
}

// Letters we've sent to this address or person, and anything waiting in the folders.
function lettersFor(e){
  const out = [];
  const keys = e.keys;
  const planRefs = new Set(planningFor(e).map(a => a.ref));
  sentContacts().forEach(c => {
    const addr = (c.lines || []).slice(1).join(', ');
    if (planRefs.has(c.ref) || (keys.length && addrKeysOf(addr).some(k => keys.includes(k))) || (e.n && samePerson(e.n, c.n))) out.push(`Letter sent to ${esc(c.name)} on ${esc(prettyDate(c.e.date))} (${esc(c.ref)}).`);
  });
  leads.forEach(l => {
    if (l.alreadyProcessed) return;
    const addr = (l.recipientLines || []).slice(1).join(', ') + ' ' + (l.site || '');
    if (planRefs.has(l.baseRef || l.ref) || (keys.length && addrKeysOf(addr).some(k => keys.includes(k))) || (e.n && samePerson(e.n, personNorm(l.applicant)))) out.push(`<b style="color:var(--red)">${esc(l.applicant)} is waiting in ${esc(FOLDERS[leadFolder(l)])}${l.include ? ', on the print list' : ''}: take them out.</b>`);
  });
  const d = getDismissed();
  planRefs.forEach(r => { if (d[r]) out.push(`${esc(r)} is in ${d[r].research ? 'Market research' : 'the Archive'}.`); });
  return out;
}

// ---- The Responses tab ----
function updateEnquiryCount(){
  const el = document.querySelector('.nav-count[data-count="responses"]');
  if (el) el.textContent = ENQ.rows.filter(e => !e.test && !e.junk && !e.notes.done).length || '';
}
async function saveEnquiryNotes(e, patch){
  e.notes = Object.assign({}, e.notes, patch);
  const r = await cloudFetch(`/rest/v1/canvass_enquiries?id=eq.${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ notes: e.notes }) });
  if (!r.ok) alert("Couldn't save that change online. Check you're signed in.");
  Object.assign(e, normaliseEnquiry({ id: e.id, site: e.site, via: e.via, payload: e.payload, notes: e.notes, received_at: e.received }));
}
function enquiryCardHtml(e){
  const plan = planningFor(e);
  const letters = lettersFor(e);
  const rough = plan.some(a => typeof estimateFor === 'function' && estimateFor(a.ref, typeof parentRefOf === 'function' ? parentRefOf(a) : null)) ? null : roughValueFor(e);
  const addrShown = e.addressText || (e.keys[0] ? e.keys[0].replace('|', ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
  const mapQ = encodeURIComponent(`${addrShown || ''} Isle of Man`);
  const planHtml = plan.length ? plan.map(a => {
    const val = typeof estimateFor === 'function' ? estimateFor(a.ref, typeof parentRefOf === 'function' ? parentRefOf(a) : null) : null;
    return `<div class="enq-plan"><b>${esc(a.ref)}</b> ${a.decision ? `<span class="tag tag-dupe">${esc(a.decision)}</span>` : ''}${val ? ` <span class="rb-val">Job ${moneyRange(val.total)}${val.groundworks ? `, groundworks ${moneyRange(val.groundworks)}` : ''}</span>` : ''}
      <div>${esc(a.description)}</div><div class="hint" style="margin:2px 0 0">${esc(a.address)}</div>
      ${typeof whoInvolvedHtml === 'function' ? whoInvolvedHtml(a) : ''}
      ${a.keyVal && typeof drawingsLinkHtml === 'function' ? `<div class="reg-links">${drawingsLinkHtml(a.keyVal)}</div>` : ''}</div>`;
  }).join('') : `<div class="hint" style="margin:0">${e.keys.length ? 'No planning application at this address yet, so no agent or engineer on record.' : 'No address in the enquiry, so it can\'t be matched to planning. Add one in the notes when you know it.'}</div>`;
  const roughHtml = rough ? `<div class="enq-box"><b>Rough job value:</b> about ${money(rough.low)} to ${money(rough.high)} (typical ${money(rough.mid)})${rough.gw ? `, groundworks about ${money(rough.gw)}` : ''}.
      <div class="hint" style="margin:2px 0 0">From ${rough.n} similar jobs the estimator has priced (${esc(rough.words.join(', '))}), e.g. ${rough.examples.map(x => `${esc(x.ref)} ${money(x.mid)}`).join(', ')}. A guess until the site visit.</div></div>` : '';
  const visit = e.notes.visit ? `<div class="enq-box"><b>How they found the website:</b> ${esc(e.notes.visit)}</div>` : '';
  const statsLink = e.via === 'website form' ? `<a class="btn-secondary" style="text-decoration:none;padding:3px 9px;font-size:0.75rem" target="_blank" rel="noopener" href="${STATS_URL}#enquiries">&#128202; Their website visit on the stats page</a>` : '';
  const status = e.notes.done ? 'tag-approved' : 'tag-enq';
  return `<div class="lead-row enq-card${ENQ.focus === e.id || ROW_OPEN.has('enq:' + e.id) ? ' open' : ''}" data-key="enq:${e.id}" data-enq-id="${e.id}" id="enq-${e.id}"><div class="lr-main">
    <div class="row-bar"><span class="rb-caret">&#9656;</span><span class="lr-applicant">${esc(e.name)}</span>
      <span class="tag tag-dupe">${esc(ENQ_SITE[e.site] || e.site)}</span><span class="rb-meta">${esc(enqWhenTime(e))} &middot; ${esc(e.via)}</span>
      ${e.test ? '<span class="tag tag-dupe">Test</span>' : e.junk ? '<span class="tag tag-dupe">Junk</span>' : `<span class="tag ${status}">${e.notes.done ? 'Dealt with' : e.notes.replied ? 'Replied' : 'New'}</span>`}
      <span class="rb-what">${esc((e.message || '').slice(0, 160))}</span></div>
    <div class="row-body">
      <div class="enq-contact">${e.email ? `&#9993; <a href="mailto:${esc(e.email)}">${esc(e.email)}</a>` : ''}${e.phone ? ` &nbsp; &#9742; <a href="tel:${esc(e.phone.replace(/\s+/g, ''))}">${esc(e.phone)}</a>` : ''}${addrShown ? ` &nbsp; &#127968; ${esc(addrShown)} <a class="btn-secondary" style="text-decoration:none;padding:1px 7px;font-size:0.7rem" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${mapQ}">Map</a>` : ''}</div>
      <div class="enq-msg">${esc(e.message || '(no message)')}</div>
      ${e.service ? `<div class="hint" style="margin:4px 0 0">Service chosen: ${esc(e.service)}</div>` : ''}
      <div class="enq-box"><b>Canvassed?</b> ${letters.length ? letters.join(' ') : 'No. Nothing sent to this address or name, so this came to us on its own.'}</div>
      <div class="enq-box"><b>Planning at their address</b>${planHtml}</div>
      ${roughHtml}${visit}
      <div class="hint" style="margin:6px 0 0">${e.page ? `Sent from ${esc(e.page)}` : ''}${e.ip ? ` &middot; IP ${esc(e.ip)}` : ''}</div>
      <label class="hint" style="display:block;margin:8px 0 0">Notes (who's dealing with it, visit booked, quote sent&hellip;)<textarea class="enq-note" rows="2">${esc(e.notes.note || '')}</textarea></label>
      <div class="reg-actions" style="margin-top:6px;grid-template-columns:repeat(auto-fit,minmax(130px,auto))">
        <button type="button" class="btn-secondary enq-replied">${e.notes.replied ? '&#10003; Replied' : 'Mark replied'}</button>
        <button type="button" class="btn-secondary enq-done">${e.notes.done ? '&#8617; Not dealt with' : 'Mark dealt with'}</button>
        <button type="button" class="btn-secondary enq-junk">${e.junk ? '&#8617; Not junk' : 'Junk / spam'}</button>
        ${statsLink}
      </div>
    </div></div></div>`;
}
async function renderResponses(main){
  main.innerHTML = '<p class="empty-state">Loading enquiries&hellip;</p>';
  await Promise.all([ENQ.loaded ? null : loadEnquiries(), buildEnquiryIndex(), typeof loadEstimatesCache === 'function' ? loadEstimatesCache() : null]);
  if (state.tab !== 'responses') return;
  const shown = ENQ.rows.filter(e => ENQ.showHidden || (!e.test && !e.junk));
  const hidden = ENQ.rows.length - ENQ.rows.filter(e => !e.test && !e.junk).length;
  main.innerHTML = `
    <div class="panel"><div class="panel-title">Responses: people who have contacted us</div>
      <p class="hint" style="margin:4px 0 0">Every enquiry from the Silverdale, Manx Drain and DGC website forms appears here within a few minutes, plus ones found in the mailboxes each morning.
      Anyone here is flagged in red on the planning list and in the folders, and the app asks before a letter goes to them.
      Each card shows whether we'd written to them, the planning at their address with its agent and engineer, and the job value.</p>
      ${ENQ.error ? `<p class="hint" style="color:var(--red)">Couldn't load enquiries: ${esc(ENQ.error)}</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="btn-secondary" id="enqRefresh">&#8635; Check for new</button>
        <button type="button" class="btn-secondary" id="enqAdd">+ Add one by hand (phone call, email)</button>
        ${hidden ? `<button type="button" class="btn-secondary" id="enqHidden">${ENQ.showHidden ? 'Hide' : 'Show'} ${hidden} test / junk</button>` : ''}
      </div>
      <form id="enqAddForm" style="display:none;margin-top:10px;gap:6px;flex-direction:column;max-width:560px">
        <select name="site"><option value="silverdale">Silverdale</option><option value="dgc">DGC</option><option value="manx">Manx Drain Solutions</option></select>
        <input name="name" placeholder="Name" required><input name="email" placeholder="Email"><input name="phone" placeholder="Phone">
        <input name="address" placeholder="Address (house number and road, so it can be matched to planning)">
        <textarea name="message" rows="3" placeholder="What they want"></textarea>
        <button type="submit" class="btn-primary">Save enquiry</button>
      </form>
    </div>
    ${shown.length ? shown.map(enquiryCardHtml).join('') : '<p class="empty-state">No enquiries yet.</p>'}`;
  updateEnquiryCount();
  if (ENQ.focus) { const el = document.getElementById('enq-' + ENQ.focus); if (el) el.scrollIntoView({ block: 'start' }); ENQ.focus = null; }
  main.querySelector('#enqRefresh').onclick = async () => { await loadEnquiries(true); ENQ.index = null; render(); };
  const hb = main.querySelector('#enqHidden'); if (hb) hb.onclick = () => { ENQ.showHidden = !ENQ.showHidden; render(); };
  main.querySelector('#enqAdd').onclick = () => { const f = main.querySelector('#enqAddForm'); f.style.display = f.style.display === 'none' ? 'flex' : 'none'; };
  main.querySelector('#enqAddForm').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target), p = Object.fromEntries(f.entries());
    const payload = { site: p.site, via: 'added by hand', received: new Date().toISOString(), name: p.name, email: p.email, phone: p.phone, address: p.address, message: p.message, added_by: cloud.email || '', dedupe: 'manual-' + Date.now() };
    const r = await cloudFetch('/rest/v1/rpc/canvass_capture_enquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }) });
    if (!r.ok) { alert("Couldn't save it online."); return; }
    await loadEnquiries(true); render();
  };
  main.querySelectorAll('.enq-card').forEach(card => {
    const e = ENQ.rows.find(x => x.id === Number(card.dataset.enqId));
    if (!e) return;
    const note = card.querySelector('.enq-note');
    note.addEventListener('change', () => saveEnquiryNotes(e, { note: note.value }));
    card.querySelector('.enq-replied').onclick = async () => { await saveEnquiryNotes(e, { replied: !e.notes.replied }); render(); };
    card.querySelector('.enq-done').onclick = async () => { await saveEnquiryNotes(e, { done: !e.notes.done }); render(); };
    card.querySelector('.enq-junk').onclick = async () => { await saveEnquiryNotes(e, { junk: !e.junk }); render(); };
  });
}

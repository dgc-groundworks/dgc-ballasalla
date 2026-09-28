// ---- Search everything (28 Sep 2026) ----
// One box in the top bar. Searches the planning list, every folder, the archive (sent and not chasing),
// Market research and Responses. Click a result to jump to that tab with the row opened and highlighted.

const SEARCH = { reg: null, regAt: 0, active: -1, results: [] };
const FOLDER_TAB = { approved: 'fApproved', pending: 'fPending', business: 'fBusiness', personal: 'fPersonal' };

async function searchRegister(){
  if (SEARCH.reg && Date.now() - SEARCH.regAt < 10 * 60 * 1000) return SEARCH.reg;
  try { const r = await privateJson(REGISTER_DATA_URL, REGISTER_DATA_URL); SEARCH.reg = (r && r.applications) || []; SEARCH.regAt = Date.now(); }
  catch { SEARCH.reg = SEARCH.reg || []; }
  return SEARCH.reg;
}
function searchEntries(apps){
  const out = [];
  const log = getLog(), dis = getDismissed();
  const dealt = new Set([...Object.keys(log), ...Object.keys(dis)]);
  const addrOf = lines => (lines || []).slice(1).filter(Boolean).join(', ');
  leads.filter(l => !l.alreadyProcessed).forEach(l => {
    dealt.add(l.ref);
    const f = leadFolder(l);
    out.push({ tab: FOLDER_TAB[f], key: 'f:' + l.ref, ref: l.baseRef || l.ref, name: l.applicant || l.ref,
      where: `${FOLDERS[f]} folder${l.include ? ', on the print list' : ''}`, addr: addrOf(l.recipientLines) || l.site || '',
      text: `${l.ref} ${l.description || ''} ${l.site || ''} ${l.agentText || ''} ${l.trade || ''}` });
  });
  Object.entries(log).forEach(([ref, e]) => out.push({ tab: 'archive', key: 'sent:' + ref, ref, name: e.name || ref,
    where: `Archive: letter sent ${prettyDate(e.date)}`, addr: addrOf(e.recipientLines), text: `${ref} ${e.description || ''} ${e.address || ''}` }));
  Object.entries(dis).forEach(([ref, e]) => out.push(e.research
    ? { tab: 'research', key: 'rs:' + ref, ref, name: e.name || ref, where: 'Market research', addr: e.address || '', text: `${ref} ${e.description || ''} ${e.note || ''}` }
    : { tab: 'archive', key: 'archived:' + ref, ref, name: e.name || ref, where: `Archive: not chasing (${prettyDate(e.date)})`, addr: e.address || '', text: `${ref} ${e.description || ''} ${e.note || ''}` }));
  (apps || []).filter(a => !dealt.has(a.ref)).forEach(a => out.push({ tab: 'import', key: a.ref, ref: a.ref,
    name: a.applicantName || a.agentCompanyName || a.agentName || a.ref, where: `Planning list${a.received ? ', applied ' + a.received : ''}`,
    addr: a.address || '', text: `${a.ref} ${a.description || ''} ${a.agentName || ''} ${a.agentCompanyName || ''} ${a.parish || ''}` }));
  if (typeof ENQ !== 'undefined') ENQ.rows.filter(e => !e.test).forEach(e => out.push({ tab: 'responses', key: 'enq:' + e.id, id: e.id, ref: '',
    name: e.name, where: `Responses: contacted ${ENQ_SITE[e.site] || e.site} ${enqWhen(e)}`, addr: e.addressText || '',
    text: `${e.email} ${e.phone} ${e.message} ${e.service}` }));
  return out;
}
function searchMatch(entries, q){
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1 || /\d/.test(w));
  if (!words.length) return [];
  const scored = [];
  for (const x of entries) {
    const name = x.name.toLowerCase(), hay = `${name} ${x.addr} ${x.text}`.toLowerCase();
    if (!words.every(w => hay.includes(w))) continue;
    const score = words.reduce((s, w) => s + (name.includes(w) ? 3 : 0) + (x.addr.toLowerCase().includes(w) ? 2 : 0) + (x.ref.toLowerCase().includes(w) ? 2 : 0), 0);
    scored.push({ x, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 60).map(s => s.x);
}
function searchHighlight(s, q){
  let h = esc(s);
  q.split(/\s+/).filter(w => w.length > 1).forEach(w => { h = h.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); });
  return h;
}
function searchSnippet(x, q){
  const w = q.toLowerCase().split(/\s+/).find(w => w.length > 1 && x.text.toLowerCase().includes(w) && !x.name.toLowerCase().includes(w) && !x.addr.toLowerCase().includes(w));
  if (!w) return '';
  const t = x.text.replace(/\s+/g, ' '), i = t.toLowerCase().indexOf(w);
  return (i > 40 ? '&hellip;' : '') + searchHighlight(t.slice(Math.max(0, i - 40), i + 80), q) + '&hellip;';
}

async function runSearch(){
  const box = document.getElementById('gsResults'), q = document.getElementById('gsInput').value.trim();
  if (q.length < 2) { box.style.display = 'none'; return; }
  const apps = await searchRegister();
  if (document.getElementById('gsInput').value.trim() !== q) return;   // typed on since
  SEARCH.results = searchMatch(searchEntries(apps), q);
  SEARCH.active = -1;
  box.innerHTML = SEARCH.results.length
    ? `<div class="gs-count">${SEARCH.results.length === 60 ? 'First 60' : SEARCH.results.length} match${SEARCH.results.length === 1 ? '' : 'es'}</div>` + SEARCH.results.map((x, i) => `
      <button type="button" class="gs-item" data-i="${i}">
        <span class="gs-name">${searchHighlight(x.name, q)}</span><span class="gs-where">${esc(x.where)}</span>
        <span class="gs-sub">${x.ref ? searchHighlight(x.ref, q) + ' &middot; ' : ''}${searchHighlight(x.addr || '', q)}</span>
        ${searchSnippet(x, q) ? `<span class="gs-sub">${searchSnippet(x, q)}</span>` : ''}
      </button>`).join('')
    : '<div class="gs-count">No matches in the planning list, folders, archive, research or responses.</div>';
  box.style.display = 'block';
}
const waitFor = (fn, ms = 15000) => new Promise(res => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v || Date.now() - t0 > ms) return res(v); setTimeout(tick, 200); }; tick(); });
async function searchJump(x){
  document.getElementById('gsResults').style.display = 'none';
  state.tab = x.tab;
  if (x.tab === 'archive') { state.archiveFilter = 'all'; (state.archiveOpen || (state.archiveOpen = new Set())).add(x.key); }
  else if (x.tab === 'responses') ENQ.focus = x.id;
  else ROW_OPEN.add(x.key);
  render();
  if (x.tab === 'import') {
    // Show just this application, whatever dates or filters were set.
    await waitFor(() => document.getElementById('regSearch'));
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('regWhen', 'all'); set('regKind', 'all'); set('regStatus', 'all'); set('regFrom', ''); set('regTo', ''); set('regSearch', x.ref);
    const s = document.getElementById('regSearch'); if (s) s.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const el = await waitFor(() => x.tab === 'archive'
    ? (document.querySelector(`.ar-toggle[data-key="${CSS.escape(x.key)}"]`) || {}).closest?.('.lead-row')
    : document.querySelector(`.lead-row[data-key="${CSS.escape(x.key)}"]`));
  if (!el) { alert(`Couldn't find ${x.name} on the page (${x.where}). It may be hidden by a filter on that tab.`); return; }
  el.classList.add('open');
  const grp = el.closest('.grp'); if (grp) { grp.classList.add('open'); GRP_OPEN.add(grp.dataset.key); }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('gs-flash'); void el.offsetWidth; el.classList.add('gs-flash');
}

(function setupSearch(){
  const bar = document.querySelector('.topbar');
  if (!bar || document.getElementById('gsInput')) return;
  const wrap = document.createElement('div');
  wrap.className = 'gs-wrap';
  wrap.innerHTML = '<input type="search" id="gsInput" placeholder="&#128269; Search everything: name, address, ref, words&hellip;" autocomplete="off"><div id="gsResults" class="gs-results"></div>';
  bar.insertBefore(wrap, bar.querySelector('.sub'));
  const input = wrap.querySelector('#gsInput'), box = wrap.querySelector('#gsResults');
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 250); });
  input.addEventListener('focus', () => { if (SEARCH.results.length && input.value.trim().length > 1) box.style.display = 'block'; });
  input.addEventListener('keydown', e => {
    const items = [...box.querySelectorAll('.gs-item')];
    if (e.key === 'Escape') { box.style.display = 'none'; input.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      SEARCH.active = (SEARCH.active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((b, i) => b.classList.toggle('active', i === SEARCH.active)); items[SEARCH.active].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') { e.preventDefault(); const x = SEARCH.results[Math.max(0, SEARCH.active)]; if (x) searchJump(x); }
  });
  box.addEventListener('click', e => { const b = e.target.closest('.gs-item'); if (b) searchJump(SEARCH.results[Number(b.dataset.i)]); });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) box.style.display = 'none'; });
})();

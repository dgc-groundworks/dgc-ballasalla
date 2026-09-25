// Silverdale Canvassing: Market tab and job value estimates.
// Reads register-data/estimates.jsonl (one line per application, written by
// scripts/estimate_values.py in the weekly pull) from the private store, and
// works out totals in the browser so the period, status and grade filters are
// instant. Also holds the estimator's prompt and rate book editor.
// Depends on index.html for: esc, privateFile, privateJson, cloudFetch, BUCKET,
// regDate, fmtDay, state, render, and (optionally) documentsLink.

(function injectMarketStyles(){
  const css = `
  .mk-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0 18px}
  .mk-controls select{background:var(--surf2);color:var(--text);border:1px solid var(--bord);border-radius:6px;padding:7px 10px;font:inherit}
  .mk-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:22px}
  .mk-card{background:var(--surf);border:1px solid var(--bord);border-radius:10px;padding:14px}
  .mk-card .k{font-size:0.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .mk-card .v{font-size:1.35rem;font-weight:800;color:var(--text);margin-top:4px}
  .mk-card .s{font-size:0.8rem;color:var(--muted);margin-top:4px}
  .mk-section{background:var(--surf);border:1px solid var(--bord);border-radius:10px;padding:16px;margin-bottom:18px}
  .mk-section h3{font-size:0.95rem;margin-bottom:10px;color:var(--accent)}
  .mk-bar-row{display:grid;grid-template-columns:minmax(150px,1.3fr) 3fr minmax(150px,1fr);gap:10px;align-items:center;font-size:0.82rem;margin:6px 0}
  .mk-bar{background:var(--surf2);border-radius:4px;height:14px;overflow:hidden}
  .mk-bar span{display:block;height:100%;background:var(--accent);border-radius:4px}
  .mk-bar span.gw{background:var(--green)}
  .mk-num{text-align:right;color:var(--text);font-variant-numeric:tabular-nums}
  .mk-opp{border-top:1px solid var(--bord);padding:12px 0}
  .mk-opp:first-child{border-top:0}
  .mk-opp .t{font-weight:700;color:var(--text)}
  .est-badge{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 2px}
  .est-val{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.35);color:var(--text);border-radius:6px;padding:3px 8px;font-size:0.8rem;font-weight:700}
  .est-gw{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.35)}
  .grade{border-radius:5px;padding:2px 7px;font-size:0.72rem;font-weight:800;border:1px solid var(--bord)}
  .grade.A{color:#22c55e;border-color:rgba(34,197,94,.5)} .grade.B{color:#84cc16;border-color:rgba(132,204,22,.5)}
  .grade.C{color:#f59e0b;border-color:rgba(245,158,11,.5)} .grade.D{color:var(--muted)}
  details.est-work{margin:4px 0 0;font-size:0.8rem}
  details.est-work summary{cursor:pointer;color:var(--muted)}
  details.est-work ul{margin:6px 0 0 18px;color:var(--muted)}
  .mk-editor textarea{min-height:260px;font-size:0.8rem}
  `;
  const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
})();

const MARKET = { estimates: new Map(), loaded: false, summary: null, latest: null };

async function loadEstimatesCache(){
  try {
    const r = await privateFile('register-data/estimates.jsonl');
    if (r) {
      const text = await r.text();
      MARKET.estimates = new Map(text.split('\n').filter(Boolean).map(l => { const e = JSON.parse(l); return [e.ref, e]; }));
    }
    MARKET.summary = await privateJson('register-data/market-summary.json', 'register-data/market-summary.json').catch(() => null);
  } catch {}
  MARKET.loaded = true;
}

function money(n){
  if (n == null || isNaN(n)) return '?';
  if (n >= 1e6) return '£' + (Math.round(n / 1e5) / 10) + 'm';
  if (n >= 1e3) return '£' + Math.round(n / 1e3) + 'k';
  return '£' + Math.round(n);
}
function moneyRange(r){ return r ? `${money(r[0])} to ${money(r[1])}` : '?'; }
const midOf = r => r ? (r[0] + r[1]) / 2 : 0;
const GRADE_TEXT = { A: 'Grade A: measured and priced, about ±15%', B: 'Grade B: good estimate, about ±30%', C: 'Grade C: rough guide, about ±50%', D: 'Grade D: not priced' };

// The value line under "Applying for" on each register row, with workings in a drop-down.
function estimateBadgeHtml(ref){
  const e = MARKET.estimates.get(ref);
  if (!e) return '';
  const vals = e.total
    ? `<span class="est-val" title="Estimated whole-job value">Job ${moneyRange(e.total)}</span>${e.groundworks ? `<span class="est-val est-gw" title="Groundworks and drainage share (DGC)">DGC share ${moneyRange(e.groundworks)}</span>` : ''}`
    : `<span class="hint" style="margin:0">Not priced</span>`;
  return `<div class="est-badge">${vals}<span class="grade ${esc(e.grade)}" title="${esc(GRADE_TEXT[e.grade] || '')}">${esc(e.grade)}</span></div>
    <details class="est-work"><summary>Workings and sources</summary><ul>
      <li><b>What it is:</b> ${esc(e.what)}</li>
      ${e.opportunity ? `<li><b>Why it matters:</b> ${esc(e.opportunity)}</li>` : ''}
      <li><b>Size used:</b> ${e.floorM2 ? `${e.floorM2[0]} to ${e.floorM2[1]} m² floor area` : 'no floor area'}${e.siteM2 ? `, site about ${e.siteM2} m²` : ''} (${esc(e.sizeFrom || 'not stated')})</li>
      ${e.england ? `<li><b>Same job in England:</b> roughly ${moneyRange(e.england)}</li>` : ''}
      ${e.silverdale ? `<li><b>Silverdale:</b> ${esc(e.silverdale)}</li>` : ''}
      <li><b>${esc(GRADE_TEXT[e.grade] || e.grade)}.</b> ${esc(e.why || '')}</li>
      <li><b>Sources:</b> ${(e.sources || []).map(esc).join('; ') || 'none listed'}</li>
      <li class="hint" style="list-style:none;margin-left:-18px">Estimated ${esc(e.pricedOn || '')}. A guide for canvassing and planning, not a quote.</li>
    </ul></details>`;
}

// ---- Market tab ----
const MK = { period: '90', status: 'all', grade: 'ABC' };

function marketRows(){
  const now = Date.now();
  return [...MARKET.estimates.values()].filter(e => {
    const d = regDate(e.received);
    if (MK.period !== 'all' && (!d || now - d > Number(MK.period) * 86400000)) return false;
    if (MK.status === 'approved' && e.status !== 'approved') return false;
    if (MK.status === 'pending' && e.status !== 'pending') return false;
    if (MK.status === 'closed' && !['refused', 'withdrawn', 'other'].includes(e.status)) return false;
    return true;
  });
}
function marketTotals(rows){
  const priced = rows.filter(e => MK.grade.includes(e.grade) && e.total);
  const sum = key => [0, 1].map(i => priced.reduce((s, e) => s + (e[key] ? e[key][i] : 0), 0));
  return { count: rows.length, priced: priced.length, total: sum('total'), groundworks: sum('groundworks'), england: sum('england'),
           grades: ['A', 'B', 'C', 'D'].map(g => rows.filter(e => e.grade === g).length),
           offMainsHomes: priced.filter(e => e.offMains && e.homes > 0).length, rows: priced };
}
function groupBy(rows, key){
  const g = new Map();
  rows.forEach(e => { const k = e[key] || 'Unknown'; if (!g.has(k)) g.set(k, []); g.get(k).push(e); });
  return [...g.entries()].map(([k, v]) => ({ k, n: v.length,
    total: [0, 1].map(i => v.reduce((s, e) => s + e.total[i], 0)),
    gw: [0, 1].map(i => v.reduce((s, e) => s + (e.groundworks ? e.groundworks[i] : 0), 0)) }))
    .sort((a, b) => midOf(b.total) - midOf(a.total));
}
function barsHtml(groups, limit){
  const top = groups.slice(0, limit || 12);
  const max = Math.max(1, ...top.map(g => midOf(g.total)));
  return top.map(g => `<div class="mk-bar-row">
      <div>${esc(g.k)} <span class="hint" style="margin:0">(${g.n})</span></div>
      <div><div class="mk-bar"><span style="width:${(100 * midOf(g.total) / max).toFixed(1)}%"></span></div>
           <div class="mk-bar" style="margin-top:3px;height:8px"><span class="gw" style="width:${(100 * midOf(g.gw) / max).toFixed(1)}%"></span></div></div>
      <div class="mk-num">${moneyRange(g.total)}<br><span class="hint" style="margin:0">DGC share ${moneyRange(g.gw)}</span></div>
    </div>`).join('') || '<p class="hint">Nothing priced for these filters yet.</p>';
}

async function renderMarket(main){
  main.innerHTML = '<p class="empty-state">Loading market figures&hellip;</p>';
  if (!MARKET.loaded) await loadEstimatesCache();
  if (!MARKET.latest) MARKET.latest = await privateJson('register-data/latest.json', 'register-data/latest.json').catch(() => ({ applications: [] }));
  const appsByRef = new Map((MARKET.latest.applications || []).map(a => [a.ref, a]));
  const rows = marketRows();
  const t = marketTotals(rows);
  const byType = groupBy(t.rows, 'type'), byParish = groupBy(t.rows, 'parish'), byClient = groupBy(t.rows, 'client'), byStatus = groupBy(t.rows, 'status');
  const opps = t.rows.filter(e => ['approved', 'pending'].includes(e.status) && e.groundworks)
    .sort((a, b) => midOf(b.groundworks) - midOf(a.groundworks)).slice(0, 15);
  const run = MARKET.summary && MARKET.summary.lastRun;
  const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

  main.innerHTML = `
    <h2 style="font-size:1.1rem">Market: what's being applied for, and what it's worth</h2>
    <p class="hint">Estimated from Isle of Man planning applications, priced with our own Isle of Man rates. These are ranges to guide canvassing and business planning, not quotes.</p>
    <div class="mk-controls">
      ${sel('mkPeriod', [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['all', 'Everything priced']], MK.period)}
      ${sel('mkStatus', [['all', 'All applications'], ['approved', 'Approved'], ['pending', 'Pending'], ['closed', 'Refused or withdrawn']], MK.status)}
      ${sel('mkGrade', [['ABC', 'Grades A to C'], ['AB', 'Grades A and B only'], ['A', 'Grade A only']], MK.grade)}
      <button class="btn-secondary" id="mkDigest">Save market digest</button>
    </div>
    ${MARKET.estimates.size ? '' : `<div class="mk-section"><h3>No estimates yet</h3><p class="hint" style="margin:0">They appear after a weekly pull once three things are in place: the Anthropic key in GitHub, and the prompt and rate book saved below.</p></div>`}
    <div class="mk-cards">
      <div class="mk-card"><div class="k">Applications</div><div class="v">${t.count}</div><div class="s">${t.priced} priced &middot; A ${t.grades[0]} &middot; B ${t.grades[1]} &middot; C ${t.grades[2]} &middot; D ${t.grades[3]}</div></div>
      <div class="mk-card"><div class="k">Estimated work value</div><div class="v">${money(midOf(t.total))}</div><div class="s">range ${moneyRange(t.total)}</div></div>
      <div class="mk-card"><div class="k">DGC groundworks and drainage share</div><div class="v">${money(midOf(t.groundworks))}</div><div class="s">range ${moneyRange(t.groundworks)}</div></div>
      <div class="mk-card"><div class="k">Same work in England</div><div class="v">${money(midOf(t.england))}</div><div class="s">Isle of Man prices are higher; this shows by how much</div></div>
      <div class="mk-card"><div class="k">Off-mains new homes</div><div class="v">${t.offMainsHomes}</div><div class="s">each likely needs a septic tank or treatment plant and drainage field</div></div>
    </div>
    <div class="mk-section"><h3>Value by type of work</h3><p class="hint" style="margin:0 0 8px">Orange bar: whole job. Green bar: DGC's groundworks and drainage share. Number in brackets: how many applications.</p>${barsHtml(byType)}</div>
    <div class="mk-section"><h3>Value by area</h3>${barsHtml(byParish, 14)}</div>
    <div class="mk-section"><h3>By client type</h3>${barsHtml(byClient)}<h3 style="margin-top:14px">By status</h3>${barsHtml(byStatus)}</div>
    <div class="mk-section"><h3>Top opportunities for DGC (approved or pending, largest groundworks share)</h3>
      ${opps.map(e => { const a = appsByRef.get(e.ref) || {}; return `<div class="mk-opp">
        <div class="t">${esc(e.what)}</div>
        <div class="lr-meta">${esc(e.ref)} &middot; ${esc(a.address || e.parish || '')} &middot; ${esc(e.status)}${a.agentCompanyName || a.agentName ? ` &middot; agent ${esc(a.agentCompanyName || a.agentName)}` : ''}</div>
        ${estimateBadgeHtml(e.ref)}
        ${e.keyVal && typeof documentsLink === 'function' ? `<a class="hint" href="${documentsLink(e.keyVal)}" target="_blank" rel="noopener">Drawings and documents on the planning register &nearr;</a>` : ''}
      </div>`; }).join('') || '<p class="hint">None yet.</p>'}
    </div>
    <details class="mk-section"><summary style="cursor:pointer;font-weight:700">How these figures are made</summary>
      <p class="hint">Each week Claude reads every new application: the description, the type, the list of documents, measurements taken from scaled drawings, and the proposed plan drawing where there is one. It works out what the job is and how big it is, then prices it with our private Isle of Man rate book (our own tendered rates first, then our supplier prices, then UK price book rates adjusted to Isle of Man prices). Every figure is a range with a grade: A about ±15%, B about ±30%, C about ±50%. Grade D is not priced and never counted. Totals only include the grades you choose above.</p>
      ${run ? `<p class="hint">Last run ${esc(run.ranOn || '')}: ${run.priced} priced with ${esc(run.model || '')}. Tokens used: ${Object.entries(run.usage || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v.toLocaleString()}`).join(', ')}.</p>` : ''}
    </details>
    <details class="mk-section mk-editor" id="mkEditor"><summary style="cursor:pointer;font-weight:700">Estimator settings: prompt and rate book (private)</summary>
      <p class="hint">These two files tell Claude how to estimate. They are saved in the private store only, never in the public repo. Changes apply from the next weekly pull.</p>
      <h3>Prompt</h3><textarea id="mkPrompt" placeholder="Loading&hellip;"></textarea>
      <div class="row-actions" style="margin-top:8px"><button class="btn" id="mkSavePrompt">Save prompt</button><span class="hint" id="mkPromptMsg"></span></div>
      <h3>Rate book</h3><textarea id="mkRates" placeholder="Loading&hellip;"></textarea>
      <div class="row-actions" style="margin-top:8px"><button class="btn" id="mkSaveRates">Save rate book</button><span class="hint" id="mkRatesMsg"></span></div>
    </details>`;

  [['mkPeriod', 'period'], ['mkStatus', 'status'], ['mkGrade', 'grade']].forEach(([id, key]) =>
    main.querySelector('#' + id).addEventListener('change', e => { MK[key] = e.target.value; renderMarket(main); }));
  main.querySelector('#mkDigest').addEventListener('click', () => downloadDigest(t, byType, byParish, opps, appsByRef));
  wireEstimatorEditor(main);
}

async function wireEstimatorEditor(main){
  const load = async (path, el) => { const r = await privateFile(path); el.value = r ? await r.text() : ''; if (!r) el.placeholder = 'Nothing saved yet. Paste the text here and save.'; };
  const save = async (path, el, msg) => {
    msg.textContent = 'Saving…';
    try {
      const r = await cloudFetch(`/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { 'Content-Type': 'text/markdown', 'x-upsert': 'true' }, body: el.value });
      msg.textContent = r.ok ? `Saved ${new Date().toLocaleTimeString('en-GB')}` : `Could not save (${r.status})`;
    } catch (e) { msg.textContent = 'Could not save: ' + e.message; }
  };
  const p = main.querySelector('#mkPrompt'), rb = main.querySelector('#mkRates');
  load('register-data/estimator/prompt.md', p);
  load('register-data/estimator/rate_book.md', rb);
  main.querySelector('#mkSavePrompt').addEventListener('click', () => save('register-data/estimator/prompt.md', p, main.querySelector('#mkPromptMsg')));
  main.querySelector('#mkSaveRates').addEventListener('click', () => save('register-data/estimator/rate_book.md', rb, main.querySelector('#mkRatesMsg')));
}

// A short Markdown note to drop into Obsidian.
function downloadDigest(t, byType, byParish, opps, appsByRef){
  const period = { '30': 'last 30 days', '90': 'last 90 days', '365': 'last 12 months', all: 'everything priced' }[MK.period];
  const today = new Date().toISOString().slice(0, 10);
  const line = g => `| ${g.k} | ${g.n} | ${moneyRange(g.total)} | ${moneyRange(g.gw)} |`;
  const md = `---
date: ${today}
tags: [canvassing, market-digest, planning, estimator]
---

# Market digest, ${today} (${period})

Filters: ${MK.status === 'all' ? 'all applications' : MK.status}, grades ${MK.grade.split('').join(', ')}.

- **Applications:** ${t.count} (${t.priced} priced; A ${t.grades[0]}, B ${t.grades[1]}, C ${t.grades[2]}, D ${t.grades[3]})
- **Estimated work value:** ${moneyRange(t.total)} (middle ${money(midOf(t.total))})
- **DGC groundworks and drainage share:** ${moneyRange(t.groundworks)}
- **Same work in England:** ${moneyRange(t.england)}
- **Off-mains new homes:** ${t.offMainsHomes}

## By type of work
| Type | Apps | Whole job | DGC share |
|---|---|---|---|
${byType.map(line).join('\n')}

## By area
| Area | Apps | Whole job | DGC share |
|---|---|---|---|
${byParish.slice(0, 12).map(line).join('\n')}

## Top opportunities
${opps.map(e => { const a = appsByRef.get(e.ref) || {}; return `- **${e.ref}** ${e.what} (${a.address || e.parish || ''}). Job ${moneyRange(e.total)}, DGC share ${moneyRange(e.groundworks)}, grade ${e.grade}, ${e.status}.${a.agentCompanyName || a.agentName ? ` Agent: ${a.agentCompanyName || a.agentName}.` : ''}`; }).join('\n')}

*Estimates from the Isle of Man planning register, priced by Claude with the private DGC rate book. Ranges with grades (A about ±15%, B about ±30%, C about ±50%), a guide not a quote.*
`;
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `Market Digest ${today}.md`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

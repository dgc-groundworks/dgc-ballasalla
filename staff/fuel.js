// DGC Staff Tracker — Fuel Usage
// Invoice upload parses Ellan Vannin Fuels PDFs in-browser via PDF.js,
// matches card numbers to vehicles, and saves fill-ups to Supabase.

const REST = SUPABASE_URL + '/rest/v1';
let session = null;
let vehicles = [];
let fillups = [];
let selectedMonth = null;

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(REST + path, { headers: authedHeaders(session) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPost(table, body) {
  const r = await fetch(REST + '/' + table, {
    method: 'POST',
    headers: authedHeaders(session, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPatch(table, filter, body) {
  const r = await fetch(REST + '/' + table + '?' + filter, {
    method: 'PATCH',
    headers: authedHeaders(session, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbDelete(table, filter) {
  const r = await fetch(REST + '/' + table + '?' + filter, {
    method: 'DELETE', headers: authedHeaders(session),
  });
  if (!r.ok) throw new Error(await r.text());
}

// ── Invoice parser (ported from invoice_parser.py) ───────────────────────────
// Card lines are sometimes printed twice on top of each other (to look bold),
// which reads back as "Card-number Card-number : : 444… 444… Registr. Registr. …".
// So: find the first long number after "Card-number", and the reg after "Registr.".
const CARD_RE   = /Card-number\b[^\d]*?(\d{8,})/;
const REG_RE    = /Registr\.(?:\s*Registr\.)?[\s:]*(.+)$/;
const TXN_RE    = /^\s*(\d{1,2}\.\d{2})\s+(\d{1,2}:\d{2})\s+(.*)$/;
const NUMERIC_RE = /^-?[\d.,]+$/;
const PERIOD_RE  = /Sales period\s+(\d{1,2}\.\d{1,2}\.\d{4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})/;
const INV_NO_RE  = /Number Invoice:\s*(\d+)/;

function parseNum(s) {
  s = (s || '').trim();
  if (!s) return null;
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// "TMN TMN 285 285 G G" (overprinted) -> "TMN 285 G"
function cleanReg(s) {
  let t = (s || '').replace(/:/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (t.length % 2 === 0 && t.length && t.every((x, i) => i % 2 || x === t[i + 1])) t = t.filter((x, i) => i % 2 === 0);
  return t.join(' ');
}
const normReg = s => (s || '').replace(/\s+/g, '').toUpperCase();

function reformatDDMMYYYY(s) {
  const [d, m, y] = s.split('.');
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function splitCols(rest) {
  return rest.trim().split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
}

function parseInvoiceText(text) {
  const lines = text.split('\n');
  let year = null, periodStart = null, periodEnd = null, invoiceNumber = null;

  const pm = PERIOD_RE.exec(text);
  if (pm) {
    periodStart = reformatDDMMYYYY(pm[1]);
    periodEnd   = reformatDDMMYYYY(pm[2]);
    year = parseInt(pm[2].split('.')[2], 10);
  }
  const im = INV_NO_RE.exec(text);
  if (im) invoiceNumber = im[1];

  const transactions = [];
  const regs = {};
  let currentCard = null;

  for (const line of lines) {
    const cm = CARD_RE.exec(line);
    if (cm) {
      currentCard = cm[1].trim();
      const rm = REG_RE.exec(line);
      if (rm && !regs[currentCard]) regs[currentCard] = cleanReg(rm[1]);
      continue;
    }
    if (!currentCard || line.trim().startsWith('Subtotals')) continue;
    const tm = TXN_RE.exec(line);
    if (!tm) continue;
    const [, dayMonth, , rest] = tm;
    const cols     = splitCols(rest);
    const numerics = cols.filter(c => NUMERIC_RE.test(c));
    if (numerics.length < 5) continue;
    const textCols = cols.slice(0, cols.length - numerics.length);
    if (textCols.length < 2) continue;
    const article = textCols[0];
    const site    = textCols.slice(1).join(' ');
    const litres  = parseNum(numerics[1]);
    const amount  = parseNum(numerics[numerics.length - 1]);
    const [dd, mm] = dayMonth.split('.');
    const date = year ? `${year}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}` : dayMonth;
    transactions.push({ card_number: currentCard, date, article, site, litres, amount });
  }

  return { invoiceNumber, periodStart, periodEnd, transactions, regs };
}

// Extract text from PDF using PDF.js (loaded on demand)
async function extractPdfText(arrayBuffer) {
  // PDF.js 4.x ESM — dynamic import
  const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page  = await pdf.getPage(p);
    const items = (await page.getTextContent()).items;
    // Reconstruct lines — group items by their y position
    const byY = {};
    items.forEach(item => {
      const y = Math.round(item.transform[5]);
      (byY[y] = byY[y] || []).push(item);
    });
    Object.keys(byY).sort((a, b) => b - a).forEach(y => {
      byY[y].sort((a, b) => a.transform[4] - b.transform[4]);
      text += byY[y].map(i => i.str).join(' ') + '\n';
    });
  }
  return text;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function mk(iso)       { return (iso || '').slice(0, 7); }
function fmtMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(+y, +m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

// ── Data load ─────────────────────────────────────────────────────────────────
async function loadAll() {
  const app = document.getElementById('app');
  try {
    vehicles = await sbGet('/dgc_vehicles?select=*&order=nickname');
    fillups  = await sbGet('/dgc_fuel_fillups?select=*&order=fill_date.desc');
    if (!selectedMonth) {
      const months = [...new Set(fillups.map(f => mk(f.fill_date)))].sort().reverse();
      selectedMonth = months[0] || mk(new Date().toISOString());
    }
    render();
  } catch (err) {
    app.innerHTML = `<div style="padding:24px;color:#f85149">Error loading fuel data: ${err.message}</div>`;
    console.error(err);
  }
}

// ── Main render ───────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  const vehicleById = {};
  vehicles.forEach(v => vehicleById[v.id] = v);

  const allMonths = [...new Set(fillups.map(f => mk(f.fill_date)))].sort().reverse();
  const monthFillups = fillups.filter(f => mk(f.fill_date) === selectedMonth);

  const byVehicle = {};
  monthFillups.forEach(f => {
    if (!byVehicle[f.vehicle_id]) byVehicle[f.vehicle_id] = { cost: 0, litres: 0, count: 0 };
    byVehicle[f.vehicle_id].cost   += Number(f.cost   || 0);
    byVehicle[f.vehicle_id].litres += Number(f.litres || 0);
    byVehicle[f.vehicle_id].count++;
  });

  const totalCost   = monthFillups.reduce((s, f) => s + Number(f.cost   || 0), 0);
  const totalLitres = monthFillups.reduce((s, f) => s + Number(f.litres || 0), 0);
  const vehicleRows = Object.entries(byVehicle)
    .map(([vid, stats]) => ({ v: vehicleById[vid], ...stats }))
    .filter(r => r.v)
    .sort((a, b) => b.cost - a.cost);

  app.innerHTML = `
    <header class="topbar" style="position:static">
      <h1 style="margin:0">Fuel Usage</h1>
      <button id="logoutBtn" class="secondary-btn">Log out (${session.email})</button>
    </header>
    <div style="padding:16px;max-width:860px">

      <div style="margin-bottom:18px">
        <button id="uploadInvoiceBtn" class="secondary-btn">Upload most recent invoice</button>
        <input type="file" id="invoiceFilePicker" accept=".pdf" style="display:none">
        <p id="uploadStatus" class="form-status" style="margin-top:6px"></p>
      </div>

      <div id="invoicePreview"></div>

      <section style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 style="margin:0;text-transform:uppercase;font-size:0.75rem;letter-spacing:0.08em;color:var(--accent)">Monthly Fuel Spend</h3>
          <select id="monthPicker" style="background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 8px;font-size:0.85rem">
            ${allMonths.length
              ? allMonths.map(m => `<option value="${m}" ${m === selectedMonth ? 'selected' : ''}>${fmtMonth(m)}</option>`).join('')
              : `<option value="${selectedMonth}">${fmtMonth(selectedMonth)}</option>`}
          </select>
        </div>
        ${totalCost > 0 ? `<p style="color:var(--muted);font-size:0.85rem;margin:0 0 12px">£${totalCost.toFixed(2)} total, ${totalLitres.toFixed(1)} litres across ${vehicleRows.length} vehicle(s)</p>` : ''}
        <div class="staff-list">
          ${vehicleRows.length ? vehicleRows.map(row => `
            <div class="list-row" style="cursor:default">
              <div class="row-main" style="min-width:160px"><div class="row-name">${row.v.nickname}</div>${row.v.current_driver ? `<div class="row-role" style="font-size:0.78rem;color:var(--muted)">${row.v.current_driver}</div>` : ''}</div>
              <div class="row-role" style="min-width:100px">${row.v.registration || ''}</div>
              <div class="row-spacer"></div>
              <span style="font-variant-numeric:tabular-nums;color:var(--text);font-weight:600;margin-right:16px">£${row.cost.toFixed(2)}</span>
              <span style="color:var(--muted);margin-right:16px">${row.litres.toFixed(1)}L</span>
              <span style="color:var(--muted);font-size:0.8rem">${row.count} fill-up${row.count !== 1 ? 's' : ''}</span>
            </div>`).join('') : '<p class="empty-msg">No fill-ups logged for this month.</p>'}
        </div>
      </section>

      <section style="margin-bottom:24px">
        <h3 style="text-transform:uppercase;font-size:0.75rem;letter-spacing:0.08em;color:var(--accent);margin-bottom:4px">Vehicles &amp; Registrations</h3>
        <p style="color:var(--muted);font-size:0.8rem;margin:0 0 10px">Click a vehicle to edit its nickname, registration or card number.</p>
        <div id="vehiclesList" class="staff-list">
          ${vehicles.map(v => `
            <div class="list-row ${v.status === 'Retired' ? 'off-work' : ''}" data-edit-vehicle="${v.id}" style="cursor:pointer">
              <div class="row-main"><div class="row-name">${v.nickname || '(unnamed)'}</div>${v.current_driver ? `<div class="row-role" style="font-size:0.78rem;color:var(--accent)">${v.current_driver}</div>` : ''}</div>
              <div class="row-role">${v.registration || ''}${v.card_number ? ' · Card ' + v.card_number : ''}</div>
              <div class="row-spacer"></div>
              ${v.status === 'Retired' ? '<span class="badge-offwork">RETIRED</span>' : ''}
            </div>`).join('') || '<p class="empty-msg">No vehicles yet.</p>'}
        </div>
        <div id="vehicleEditHost"></div>
        <details style="margin-top:12px">
          <summary style="cursor:pointer;color:var(--muted);font-size:0.85rem">+ Add Vehicle (registration, fuel card &amp; driver/name)</summary>
          <form id="vehicleForm" class="advance-form" style="margin-top:10px">
            <input type="text" name="nickname" placeholder="Nickname" required>
            <input type="text" name="current_driver" placeholder="Current driver">
            <input type="text" name="registration" placeholder="Registration">
            <input type="text" name="card_number" placeholder="Fuel card number">
            <button type="submit" class="primary-btn">Add Vehicle</button>
          </form>
        </details>
      </section>

      <section>
        <h3 style="text-transform:uppercase;font-size:0.75rem;letter-spacing:0.08em;color:var(--accent);margin-bottom:10px">Log a Fill-up Manually</h3>
        <form id="fillupForm" class="advance-form">
          <select name="vehicle_id" required>
            <option value="">Vehicle…</option>
            ${vehicles.filter(v => v.status !== 'Retired').map(v => `<option value="${v.id}">${v.nickname}</option>`).join('')}
          </select>
          <input type="date" name="fill_date" required value="${new Date().toISOString().slice(0,10)}">
          <input type="number" step="0.01" name="litres" placeholder="Litres">
          <input type="number" step="0.01" name="cost" placeholder="Cost £" required>
          <input type="text" name="garage" placeholder="Garage / station">
          <button type="submit" class="primary-btn">Add Fill-up</button>
        </form>
        <p id="fillupStatus" class="form-status"></p>
      </section>
    </div>`;

  bindEvents();
}

function bindEvents() {
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('monthPicker').addEventListener('change', e => {
    selectedMonth = e.target.value;
    render();
  });

  // Invoice upload
  document.getElementById('uploadInvoiceBtn').addEventListener('click', () => {
    document.getElementById('invoiceFilePicker').click();
  });
  document.getElementById('invoiceFilePicker').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    await handleInvoiceUpload(file);
  });

  // Vehicle edit
  document.querySelectorAll('[data-edit-vehicle]').forEach(row => {
    row.addEventListener('click', () => {
      const vid = row.dataset.editVehicle;
      const v   = vehicles.find(x => x.id === vid);
      if (!v) return;
      const host = document.getElementById('vehicleEditHost');
      if (host.dataset.open === vid) { host.innerHTML = ''; host.dataset.open = ''; return; }
      host.dataset.open = vid;
      host.innerHTML = `
        <form id="veForm" class="advance-form" style="margin-top:8px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px">
          <input type="text" name="nickname" value="${v.nickname || ''}" placeholder="Nickname" required>
          <input type="text" name="current_driver" value="${v.current_driver || ''}" placeholder="Current driver">
          <input type="text" name="registration" value="${v.registration || ''}" placeholder="Registration">
          <input type="text" name="card_number" value="${v.card_number || ''}" placeholder="Fuel card number">
          <button type="submit" class="primary-btn">Save</button>
          <button type="button" id="veCancelBtn" class="secondary-btn">Cancel</button>
          <button type="button" id="veRetireBtn" class="secondary-btn" style="color:#f85149">${v.status === 'Retired' ? 'Mark as Active' : 'Retire'}</button>
        </form>`;
      host.querySelector('#veCancelBtn').addEventListener('click', () => { host.innerHTML = ''; host.dataset.open = ''; });
      host.querySelector('#veRetireBtn').addEventListener('click', async () => {
        await sbPatch('dgc_vehicles', 'id=eq.' + vid, { status: v.status === 'Retired' ? 'Active' : 'Retired' });
        await loadAll();
      });
      host.querySelector('#veForm').addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        await sbPatch('dgc_vehicles', 'id=eq.' + vid, {
          nickname: fd.get('nickname'), current_driver: fd.get('current_driver') || null,
          registration: fd.get('registration') || null, card_number: fd.get('card_number') || null,
        });
        await loadAll();
      });
    });
  });

  document.getElementById('vehicleForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await sbPost('dgc_vehicles', { nickname: fd.get('nickname'), current_driver: fd.get('current_driver') || null, registration: fd.get('registration') || null, card_number: fd.get('card_number') || null, status: 'Active' });
    await loadAll();
  });

  document.getElementById('fillupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const status = document.getElementById('fillupStatus');
    const fd = new FormData(e.target);
    try {
      await sbPost('dgc_fuel_fillups', {
        vehicle_id: fd.get('vehicle_id'), fill_date: fd.get('fill_date'),
        litres: fd.get('litres') ? Number(fd.get('litres')) : null,
        cost: Number(fd.get('cost')), garage: fd.get('garage') || null,
      });
      selectedMonth = mk(fd.get('fill_date'));
      status.textContent = 'Saved ✓'; status.className = 'form-status success';
      await loadAll();
    } catch (err) {
      status.textContent = 'Error: ' + err.message; status.className = 'form-status error';
    }
  });
}

// ── Invoice upload flow ───────────────────────────────────────────────────────
// Fill-ups on cards already in the Vehicles list are matched automatically.
// Cards we don't know yet are listed with their registration, and you choose:
// add as a new vehicle (named as you like), put on an existing vehicle (its
// card number is updated to the new one), or leave out. Nothing is saved until
// you press Import.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => '£' + Number(n || 0).toFixed(2);

async function handleInvoiceUpload(file) {
  const statusEl = document.getElementById('uploadStatus');
  const preview  = document.getElementById('invoicePreview');
  statusEl.textContent = 'Reading PDF…'; statusEl.className = 'form-status';
  preview.innerHTML = '';

  let text;
  try {
    const buf = await file.arrayBuffer();
    statusEl.textContent = 'Parsing invoice…';
    text = await extractPdfText(buf);
  } catch (err) {
    statusEl.textContent = 'Could not read PDF: ' + err.message; statusEl.className = 'form-status error';
    return;
  }

  const parsed = parseInvoiceText(text);
  if (!parsed.transactions.length) {
    statusEl.textContent = 'No fill-ups found in this PDF. Is it an Ellan Vannin Fuels invoice?'; statusEl.className = 'form-status error';
    return;
  }
  statusEl.textContent = '';

  // A vehicle can hold more than one card (old and new), comma-separated
  const cardToVehicle = {};
  vehicles.forEach(v => { (v.card_number || '').split(/[,\s]+/).filter(Boolean).forEach(c => { cardToVehicle[c] = v; }); });
  const existingKeys = new Set(fillups.map(f => `${f.vehicle_id}|${f.fill_date}|${Number(f.cost).toFixed(2)}`));
  const isDup = (vid, t) => existingKeys.has(`${vid}|${t.date}|${Number(t.amount).toFixed(2)}`);

  const matched = [], unmatched = [];
  parsed.transactions.forEach(t => {
    const v = cardToVehicle[t.card_number];
    if (v) matched.push({ ...t, vehicle_id: v.id, vehicle_name: v.nickname }); else unmatched.push(t);
  });
  const toImport  = matched.filter(t => !isDup(t.vehicle_id, t));
  const duplicate = matched.length - toImport.length;

  const unknown = [...new Set(unmatched.map(u => u.card_number))].map(card => {
    const list = unmatched.filter(u => u.card_number === card);
    const reg = parsed.regs[card] || '';
    const sameReg = vehicles.find(v => normReg(v.registration) && normReg(v.registration) === normReg(reg));
    return { card, reg, list, total: list.reduce((a, t) => a + (t.amount || 0), 0), pick: sameReg ? sameReg.id : 'new' };
  });
  const invTotal = parsed.transactions.reduce((a, t) => a + (t.amount || 0), 0);
  const activeVehicles = vehicles.filter(v => v.status !== 'Retired');

  const unknownHtml = unknown.length ? `
    <div style="margin:12px 0;padding:12px;background:#2d1e00;border:1px solid #7d4e17;border-radius:8px;font-size:0.82rem;color:#e3b341">
      <div style="font-weight:700;margin-bottom:8px">${unknown.length} card${unknown.length !== 1 ? 's' : ''} on this invoice ${unknown.length !== 1 ? "aren't" : "isn't"} in your Vehicles list yet. Choose what to do with each:</div>
      ${unknown.map((u, i) => `
        <div class="fuel-unknown" data-i="${i}" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-top:1px solid rgba(227,179,65,.25)">
          <div style="min-width:220px;color:#fde68a"><b>Card …${esc(u.card.slice(-4))}</b> · ${esc(u.reg || 'no reg shown')}<br><span style="color:#e3b341">${u.list.length} fill-up${u.list.length !== 1 ? 's' : ''} · ${money(u.total)}</span></div>
          <select class="fu-pick" style="flex:1;min-width:200px">
            <option value="new" ${u.pick === 'new' ? 'selected' : ''}>Add as a new vehicle</option>
            <optgroup label="It's one of these (this card is added to it)">
              ${activeVehicles.map(v => `<option value="${v.id}" ${u.pick === v.id ? 'selected' : ''}>${esc(v.nickname)}${v.registration ? ' (' + esc(v.registration) + ')' : ''}</option>`).join('')}
            </optgroup>
            <option value="skip">Leave these out</option>
          </select>
          <input class="fu-name" type="text" value="${esc(u.reg)}" placeholder="Name for the new vehicle" style="flex:1;min-width:160px;${u.pick === 'new' ? '' : 'display:none'}">
        </div>`).join('')}
    </div>` : '';

  preview.innerHTML = `
    <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
      <h3 style="margin:0 0 6px;font-size:0.95rem">Invoice ${esc(parsed.invoiceNumber || file.name)}</h3>
      <p style="color:var(--muted);font-size:0.82rem;margin:0 0 12px">
        Period: ${parsed.periodStart || '?'} to ${parsed.periodEnd || '?'} · ${parsed.transactions.length} fill-ups, ${money(invTotal)} · ${toImport.length} new on known vehicles · ${duplicate} already imported
      </p>
      <div class="staff-list" style="margin-bottom:12px;max-height:260px;overflow-y:auto">
        ${toImport.map(t => `
          <div class="list-row" style="cursor:default;font-size:0.82rem">
            <div class="row-main"><div class="row-name" style="font-size:0.85rem">${esc(t.vehicle_name)}</div></div>
            <div class="row-role">${t.date} · ${esc(t.site)}</div>
            <div class="row-spacer"></div>
            <span style="color:var(--text);font-weight:600;margin-right:12px">${money(t.amount)}</span>
            <span style="color:var(--muted)">${t.litres ?? '?'}L</span>
          </div>`).join('') || (matched.length ? '<p class="empty-msg">All fill-ups on known vehicles are already imported.</p>' : '')}
      </div>
      ${unknownHtml}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button id="confirmImportBtn" class="primary-btn">Import</button>
        <button id="cancelImportBtn" class="secondary-btn">Cancel</button>
        <p id="importStatus" class="form-status" style="margin:0"></p>
      </div>
    </div>`;

  const rows = [...preview.querySelectorAll('.fuel-unknown')];
  const plan = () => unknown.map((u, i) => ({ ...u, pick: rows[i].querySelector('.fu-pick').value, name: rows[i].querySelector('.fu-name').value.trim() }));
  const countFor = p => p.pick === 'skip' ? 0 : p.pick === 'new' ? p.list.length : p.list.filter(t => !isDup(p.pick, t)).length;
  const refreshBtn = () => {
    const n = toImport.length + plan().reduce((a, p) => a + countFor(p), 0);
    const btn = document.getElementById('confirmImportBtn');
    btn.textContent = n ? `Import ${n} fill-up${n !== 1 ? 's' : ''}` : 'Nothing new to import';
    btn.disabled = !n;
  };
  rows.forEach(r => r.querySelector('.fu-pick').addEventListener('change', e => {
    r.querySelector('.fu-name').style.display = e.target.value === 'new' ? '' : 'none';
    refreshBtn();
  }));
  refreshBtn();

  document.getElementById('cancelImportBtn').addEventListener('click', () => { preview.innerHTML = ''; });
  document.getElementById('confirmImportBtn').addEventListener('click', async () => {
    const impStatus = document.getElementById('importStatus');
    const btn = document.getElementById('confirmImportBtn');
    btn.disabled = true; btn.textContent = 'Importing…'; impStatus.textContent = '';
    try {
      const rowsToSave = [...toImport];
      for (const p of plan()) {
        if (p.pick === 'skip') continue;
        let vid = p.pick;
        if (p.pick === 'new') {
          const made = await sbPost('dgc_vehicles', { nickname: p.name || p.reg || ('Card ' + p.card.slice(-4)), registration: p.reg || null, card_number: p.card, status: 'Active' });
          vid = made[0].id;
          p.list.forEach(t => rowsToSave.push({ ...t, vehicle_id: vid }));
        } else {
          const v = vehicles.find(x => x.id === vid);
          const cards = (v && v.card_number || '').split(/[,\s]+/).filter(Boolean);
          await sbPatch('dgc_vehicles', 'id=eq.' + vid, { card_number: [p.card, ...cards.filter(c => c !== p.card)].join(', ') });
          p.list.filter(t => !isDup(vid, t)).forEach(t => rowsToSave.push({ ...t, vehicle_id: vid }));
        }
      }
      for (const t of rowsToSave) {
        await sbPost('dgc_fuel_fillups', { vehicle_id: t.vehicle_id, fill_date: t.date, garage: t.site || null, litres: t.litres ?? null, cost: t.amount });
      }
      preview.innerHTML = '';
      statusEl.textContent = `Imported ${rowsToSave.length} fill-up${rowsToSave.length !== 1 ? 's' : ''} from invoice ${parsed.invoiceNumber || ''}.`;
      statusEl.className = 'form-status success';
      selectedMonth = parsed.periodEnd ? mk(parsed.periodEnd) : selectedMonth;
      await loadAll();
    } catch (err) {
      impStatus.textContent = 'Error: ' + err.message; impStatus.className = 'form-status error';
      btn.disabled = false; btn.textContent = 'Retry';
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const app = document.getElementById('app');
  session = await ensureLoggedIn();
  if (!session) { window.location.replace('index.html'); return; }
  await loadAll();
})();

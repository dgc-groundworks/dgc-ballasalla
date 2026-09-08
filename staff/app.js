// DGC Staff Tracker — Hours (Supabase-backed live version)
// Reads/writes dgc_staff, dgc_staff_hours, dgc_staff_advances, dgc_staff_leave directly.
// SUPABASE_URL / SUPABASE_KEY come from config.js.

const REST = SUPABASE_URL + '/rest/v1';

const BANK_HOLIDAYS = new Set([
  '2025-01-01','2025-04-18','2025-04-21','2025-05-05','2025-06-06','2025-07-07','2025-08-25','2025-12-25','2025-12-26',
  '2026-01-01','2026-04-03','2026-04-06','2026-05-04','2026-06-05','2026-07-06','2026-08-31','2026-12-25','2026-12-28',
  '2027-01-01','2027-03-26','2027-03-29','2027-05-03','2027-06-04','2027-07-05','2027-08-30','2027-12-27','2027-12-28',
]);

const ANCHOR_VAL = Date.UTC(2026, 7, 1); // Sat 1 Aug 2026 — fortnight grid anchor
const PERIOD_DAYS = 14;

// The staff-facing Timesheet app runs its own Monday-anchored fortnight
// (2026-08-31) — 2 days offset from this Saturday-anchored admin grid.
// That's deliberate on both sides (staff get a Mon-Sun window with a
// weekend grace period; this grid follows the actual Sat-Fri pay cycle) —
// don't try to make them match. To find whether someone's pressed "Send"
// for whatever's showing here, find which staff-side period(s) overlap
// the admin period currently on screen.
const STAFF_FORTNIGHT_ANCHOR = Date.UTC(2026, 7, 31); // Mon 31 Aug 2026
function staffPeriodsOverlapping(adminFromVal, adminToVal) {
  const starts = [];
  const roughN = Math.floor((adminFromVal - STAFF_FORTNIGHT_ANCHOR) / 86400000 / 14);
  for (let n = roughN - 1; n <= roughN + 1; n++) {
    const start = STAFF_FORTNIGHT_ANCHOR + n * 14 * 86400000;
    const end = start + 13 * 86400000;
    if (start <= adminToVal && end >= adminFromVal) starts.push(isoFromVal(start));
  }
  return starts;
}

function sbHeaders(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}
async function sbGet(path) {
  const r = await fetch(REST + path, { headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPost(table, body) {
  const r = await fetch(REST + '/' + table, { method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPatch(table, filter, body) {
  const r = await fetch(REST + '/' + table + '?' + filter, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbDelete(table, filter) {
  const r = await fetch(REST + '/' + table + '?' + filter, { method: 'DELETE', headers: sbHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return true;
}

function isoFromVal(t) { return new Date(t).toISOString().slice(0, 10); }
function valFromIso(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function addDaysVal(t, n) { return t + n * 86400000; }
function todayVal() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
function isWeekday(iso) { const dow = new Date(valFromIso(iso)).getUTCDay(); return dow >= 1 && dow <= 5; }
function periodStartValFor(t) {
  const days = Math.floor((t - ANCHOR_VAL) / 86400000);
  const idx = Math.floor(days / PERIOD_DAYS);
  return ANCHOR_VAL + idx * PERIOD_DAYS * 86400000;
}
function fmtShort(iso) {
  const d = new Date(valFromIso(iso));
  return d.getUTCDate() + ' ' + d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
}

// Salaried staff: blank weekdays auto-show contracted hours (read-only, for reference)
const SALARIED = new Map([
  ['Andy Wynne-Smythe', 8],
  ['Andrew Wynne-Smythe', 8],
]);

// Salaried staff excluded from the hours grid entirely (PMs — tracked separately)
const EXCLUDED_FROM_HOURS = new Set([
  'John McLoughlin', 'John Mcloughlin',
  'Andy Wynne-Smythe', 'Andrew Wynne-Smythe',
]);

let periodStartVal = periodStartValFor(todayVal());
let week1Approved = false;
let week2Approved = false;
let periodDates = [];
let staff = [];
let staffById = {};
let hoursCache = {}; // `${staff_id}_${date}` -> {id, hours}
let leaveCache = [];
let advancesCache = [];
let confirmedNames = new Set(); // staff who've pressed "Send" on the Timesheet app for a period overlapping this one
let fillActive = false;
let fillSnapshot = null;
let rowFillSnapshots = {}; // staffId -> {date: originalValue}, per-row fill undo
const saveTimers = {};

function computePeriodDates() {
  periodDates = [];
  for (let i = 0; i < PERIOD_DAYS; i++) periodDates.push(isoFromVal(addDaysVal(periodStartVal, i)));
}

async function loadAll() {
  computePeriodDates();
  const from = periodDates[0], to = periodDates[PERIOD_DAYS - 1];
  document.getElementById('hoursPeriodLabel').textContent =
    fmtShort(from) + ' — ' + fmtShort(to) + ' ' + String(new Date(valFromIso(to)).getUTCFullYear()).slice(2);

  const week2Start = periodDates[7];
  const overlappingStaffPeriods = staffPeriodsOverlapping(valFromIso(from), valFromIso(to));
  const [staffRows, hourRows, leaveRows, advRows, approval1Rows, approval2Rows, tsRows, confirmRows] = await Promise.all([
    sbGet('/dgc_staff?select=id,name,role,rate,active&order=name'),
    sbGet('/dgc_staff_hours?select=id,staff_id,work_date,hours&work_date=gte.' + from + '&work_date=lte.' + to),
    sbGet('/dgc_staff_leave?select=*&from_date=lte.' + to + '&to_date=gte.' + from),
    sbGet('/dgc_staff_advances?select=*&entry_date=gte.' + from + '&entry_date=lte.' + to + '&order=entry_date.desc'),
    sbGet('/dgc_payroll_approval?select=*&period_start=eq.' + from).catch(() => []),
    sbGet('/dgc_payroll_approval?select=*&period_start=eq.' + week2Start).catch(() => []),
    ensureLoggedIn().then(sess => {
      const token = sess ? sess.access_token : SUPABASE_KEY;
      return fetch(REST + '/dgc_timesheets?select=staff_name,work_date,hours&work_date=gte.' + from + '&work_date=lte.' + to,
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } })
        .then(r => r.ok ? r.json() : []).catch(() => []);
    }).catch(() => []),
    (overlappingStaffPeriods.length
      ? sbGet('/dgc_timesheet_confirmations?select=staff_name&period_start=in.(' + overlappingStaffPeriods.join(',') + ')')
      : Promise.resolve([])
    ).catch(() => []),
  ]);

  confirmedNames = new Set((Array.isArray(confirmRows) ? confirmRows : []).map(r => r.staff_name));

  staffById = {};
  staffRows.forEach(s => staffById[s.id] = s);

  // Show everyone active, plus anyone inactive who still has activity logged
  // in this specific fortnight (e.g. left partway through it) — a leaver's
  // final pay period must still show their real hours.
  const activeIds = new Set();
  hourRows.forEach(h => activeIds.add(h.staff_id));
  leaveRows.forEach(b => activeIds.add(b.staff_id));
  advRows.forEach(a => activeIds.add(a.staff_id));
  staff = staffRows.filter(s => (s.active || activeIds.has(s.id)) && !EXCLUDED_FROM_HOURS.has(s.name));

  hoursCache = {};
  // Load manual entries first
  hourRows.forEach(h => hoursCache[h.staff_id + '_' + h.work_date] = { id: h.id, hours: h.hours });
  // Worker timesheet submissions override — they carry true decimal hours (e.g. 8.5)
  const staffByName = {};
  staffRows.forEach(s => { staffByName[s.name.trim().toLowerCase()] = s.id; });
  (Array.isArray(tsRows) ? tsRows : []).forEach(t => {
    const sid = staffByName[(t.staff_name || '').trim().toLowerCase()];
    if (sid && parseFloat(t.hours) > 0) {
      const key = sid + '_' + t.work_date;
      const existing = hoursCache[key];
      hoursCache[key] = { id: existing ? existing.id : null, hours: parseFloat(t.hours) };
    }
  });

  leaveCache = leaveRows;
  advancesCache = advRows;
  week1Approved = Array.isArray(approval1Rows) && approval1Rows.length > 0;
  week2Approved = Array.isArray(approval2Rows) && approval2Rows.length > 0;

  fillActive = false;
  fillSnapshot = null;
  rowFillSnapshots = {};

  renderStaffSelects();
  renderHours();
  renderAdvances();
  renderHolidays();
  renderApprovalState();
  renderWagesBroughtForward();
}

// Flags hours entered AFTER a week was already approved/locked for pay —
// those hours never made that pay run, so they need a manual backpay
// adjustment. This never auto-adds anything to the current grid; it's a
// read-only heads-up so the PM doesn't forget who's owed a top-up.
// Caveat: only catches a brand-new day being logged late (created_at is set
// on INSERT only) — editing an hours row that already existed before
// approval won't be flagged, since created_at doesn't change on a PATCH.
async function renderWagesBroughtForward() {
  const section = document.getElementById('wagesForwardSection');
  const list = document.getElementById('wagesForwardList');
  section.hidden = true;
  list.innerHTML = '';

  const prevPeriodStart = periodStartVal - PERIOD_DAYS * 86400000;
  const prevDates = [];
  for (let i = 0; i < PERIOD_DAYS; i++) prevDates.push(isoFromVal(addDaysVal(prevPeriodStart, i)));
  const prevWeek1Start = prevDates[0], prevWeek2Start = prevDates[7];

  let approvals;
  try {
    approvals = await sbGet('/dgc_payroll_approval?select=*&period_start=in.(' + prevWeek1Start + ',' + prevWeek2Start + ')');
  } catch (e) { return; }
  if (!Array.isArray(approvals) || !approvals.length) return; // last fortnight was never approved — nothing to flag yet

  const approvalByStart = {};
  approvals.forEach(a => approvalByStart[a.period_start] = a);

  const ranges = [];
  if (approvalByStart[prevWeek1Start]) ranges.push({ from: prevDates[0], to: prevDates[6], approvedAt: approvalByStart[prevWeek1Start].approved_at });
  if (approvalByStart[prevWeek2Start]) ranges.push({ from: prevDates[7], to: prevDates[13], approvedAt: approvalByStart[prevWeek2Start].approved_at });
  if (!ranges.length) return;

  let lateRows;
  try {
    const results = await Promise.all(ranges.map(r =>
      sbGet('/dgc_staff_hours?select=staff_id,work_date,hours,created_at&work_date=gte.' + r.from + '&work_date=lte.' + r.to)
        .then(rows => rows.filter(row => row.created_at && row.created_at > r.approvedAt))
    ));
    lateRows = results.flat();
  } catch (e) { return; }
  if (!lateRows.length) return;

  lateRows.sort((a, b) => a.work_date < b.work_date ? -1 : 1);
  list.innerHTML = lateRows.map(r => {
    const name = (staffById[r.staff_id] && staffById[r.staff_id].name) || 'Unknown staff';
    const when = new Date(r.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="advance-row">
      <div class="row-fields">
        <span class="advance-date">${fmtShort(r.work_date)}</span>
        <span class="advance-name">${name}</span>
        <span class="advance-type">${Number(r.hours).toFixed(1)}h</span>
        <span class="advance-notes">Added ${when}, after that week was approved</span>
      </div>
    </div>`;
  }).join('');
  section.hidden = false;
}

function renderStaffSelects() {
  for (const selId of ['advStaff', 'holStaff']) {
    const sel = document.getElementById(selId);
    const current = sel.value;
    sel.innerHTML = '<option value="">Staff member…</option>' +
      staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    sel.value = current;
  }
}

function overtimeFor(staffId) {
  return advancesCache.filter(a => a.staff_id === staffId && a.entry_type === 'Overtime')
    .reduce((sum, a) => sum + Number(a.amount), 0);
}
function moneyFor(staffId, type) {
  return advancesCache.filter(a => a.staff_id === staffId && a.entry_type === type)
    .reduce((sum, a) => sum + Number(a.amount), 0);
}
function leaveCovering(staffId, date) {
  return leaveCache.find(b => b.staff_id === staffId && date >= b.from_date && date <= b.to_date);
}
function cellFor(staffId, date) {
  const hourEntry = hoursCache[staffId + '_' + date];
  if (hourEntry && hourEntry.hours !== null && hourEntry.hours !== undefined) {
    return { kind: 'hours', value: hourEntry.hours };
  }
  if (!isWeekday(date)) return { kind: 'weekend' };
  if (BANK_HOLIDAYS.has(date)) return { kind: 'BH' };
  const leave = leaveCovering(staffId, date);
  if (leave) return { kind: leave.leave_type === 'Holiday' ? 'H' : 'U' };
  return { kind: 'blank' };
}
function rowTotal(staffId, staffName) {
  const salaryHrs = SALARIED.get(staffName) || 0;
  let total = 0;
  periodDates.forEach(date => {
    const c = cellFor(staffId, date);
    if (c.kind === 'hours') total += Number(c.value) || 0;
    else if (c.kind === 'BH' || c.kind === 'H') total += 8;
    else if (c.kind === 'blank' && salaryHrs) total += salaryHrs;
  });
  return total + overtimeFor(staffId);
}

function renderHours() {
  const table = document.getElementById('hoursTable');
  const todayIso = isoFromVal(todayVal());
  let head = '<tr><th class="hours-name">Name</th>';
  periodDates.forEach(date => {
    const d = new Date(valFromIso(date));
    const isToday = date === todayIso;
    head += `<th class="${isToday ? 'today-col' : ''}"><div class="day-head"><span class="day-name">${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span><span class="day-num">${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</span></div></th>`;
  });
  head += '<th>Fill</th><th>OT</th><th>Total</th></tr>';

  let body = '';
  const dayTotals = periodDates.map(() => 0);
  let footOT = 0, footTotal = 0, footAdv = 0, footBonus = 0;

  staff.forEach(s => {
    const ot = overtimeFor(s.id);
    const salaryHrs = SALARIED.get(s.name) || 0;
    const total = rowTotal(s.id, s.name);
    footOT += ot; footTotal += total; footAdv += moneyFor(s.id, 'Advance'); footBonus += moneyFor(s.id, 'Bonus');

    const sentTick = confirmedNames.has(s.name) ? ' <span class="send-tick" title="Sent their hours — happy with this fortnight">&#10003;</span>' : '';
    body += `<tr data-staff="${s.id}"><td class="hours-name">${s.name}${sentTick}${salaryHrs ? ' <span style="font-size:0.7em;color:var(--muted);font-weight:400">(salary)</span>' : ''}</td>`;
    periodDates.forEach((date, i) => {
      const c = cellFor(s.id, date);
      const todayCls = date === todayIso ? 'today-col' : '';
      const isLocked = i < 7 ? week1Approved : week2Approved;
      if (c.kind === 'hours') {
        dayTotals[i] += Number(c.value) || 0;
        if (isLocked) {
          body += `<td class="hours-readonly ${todayCls}">${Number(c.value) || ''}</td>`;
        } else {
          body += `<td class="${todayCls}"><input class="hours-cell" type="number" step="0.5" min="0" data-date="${date}" value="${c.value}"></td>`;
        }
      } else if (c.kind === 'weekend') {
        body += `<td class="${todayCls}"></td>`;
      } else if (c.kind === 'blank') {
        if (salaryHrs) {
          // Salaried staff: show contracted hours read-only for reference
          dayTotals[i] += salaryHrs;
          body += `<td class="hours-readonly ${todayCls}" style="color:var(--muted);font-style:italic" title="Salaried — ${salaryHrs}h/day reference">${salaryHrs}</td>`;
        } else if (isLocked) {
          body += `<td class="hours-readonly ${todayCls}"></td>`;
        } else {
          body += `<td class="${todayCls}"><input class="hours-cell" type="number" step="0.5" min="0" data-date="${date}" value=""></td>`;
        }
      } else {
        if (c.kind === 'BH' || c.kind === 'H') dayTotals[i] += 8;
        body += `<td class="hours-readonly ${todayCls}">${c.kind}</td>`;
      }
    });
    const bothApproved = week1Approved && week2Approved;
    body += `<td>${bothApproved ? '' : `<button class="row-fill-btn${s.id in rowFillSnapshots ? ' active' : ''}" data-staff="${s.id}">→8</button>`}</td>`;
    body += `<td class="hours-readonly clickable" data-jump="${s.id}" data-jump-type="Overtime">${ot || 0}h</td>`;
    body += `<td class="hours-readonly">${total}</td>`;
    body += '</tr>';
  });

  let foot = '<tr class="hours-footer-row"><td>TEAM TOTALS</td>';
  dayTotals.forEach(t => foot += `<td>${t || ''}</td>`);
  foot += `<td></td><td>${footOT > 0 ? footOT.toFixed(1)+'h' : ''}</td><td>${footTotal > 0 ? footTotal.toFixed(1) : ''}</td></tr>`;
  foot += `<tr class="hours-footer-row"><td colspan="${PERIOD_DAYS + 1}" style="text-align:right">Advances £${footAdv.toFixed(2)} · Bonuses £${footBonus.toFixed(2)}</td><td colspan="2"></td></tr>`;

  table.innerHTML = head + body + foot;
}

function scheduleSave(staffId, date, input) {
  const key = staffId + '_' + date;
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => flushCell(staffId, date, input), 1500);
}
async function flushCell(staffId, date, input) {
  clearTimeout(saveTimers[staffId + '_' + date]);
  const raw = input.value.trim();
  const key = staffId + '_' + date;
  const existing = hoursCache[key];
  document.getElementById('hoursStatus').textContent = 'Saving…';
  try {
    const hours = raw === '' ? null : Number(raw);
    if (raw === '' || hours === 0) {
      if (existing) { await sbDelete('dgc_staff_hours', 'id=eq.' + existing.id); delete hoursCache[key]; }
    } else {
      if (existing) {
        await sbPatch('dgc_staff_hours', 'id=eq.' + existing.id, { hours });
        hoursCache[key] = { id: existing.id, hours };
      } else {
        const [row] = await sbPost('dgc_staff_hours', { staff_id: staffId, work_date: date, hours });
        hoursCache[key] = { id: row.id, hours };
      }
    }
    document.getElementById('hoursStatus').textContent = 'Saved ✓ ' + new Date().toLocaleTimeString('en-GB');
  } catch (e) {
    document.getElementById('hoursStatus').textContent = 'Save failed — check connection';
    console.error(e);
  }
}

document.getElementById('hoursTable').addEventListener('input', e => {
  if (!e.target.classList.contains('hours-cell')) return;
  const tr = e.target.closest('tr');
  const staffId = tr.dataset.staff;
  const date = e.target.dataset.date;
  scheduleSave(staffId, date, e.target);
});

document.getElementById('hoursTable').addEventListener('click', e => {
  if (e.target.classList.contains('row-fill-btn')) {
    toggleFillOnePerson(e.target.dataset.staff);
  }
  if (e.target.dataset.jump) {
    document.getElementById('advStaff').value = e.target.dataset.jump;
    document.getElementById('advType').value = e.target.dataset.jumpType || 'Overtime';
    updateAmountUnit();
    document.getElementById('advAmount').focus();
  }
});

async function toggleFillOnePerson(staffId) {
  const tr = document.querySelector(`tr[data-staff="${staffId}"]`);
  const inputs = tr.querySelectorAll('.hours-cell');
  if (staffId in rowFillSnapshots) {
    const snap = rowFillSnapshots[staffId];
    for (const input of inputs) {
      const date = input.dataset.date;
      if (date in snap) {
        input.value = snap[date];
        await flushCell(staffId, date, input);
      }
    }
    delete rowFillSnapshots[staffId];
  } else {
    const snap = {};
    for (const input of inputs) {
      if (!isWeekday(input.dataset.date)) continue;
      snap[input.dataset.date] = input.value;
      if (input.value.trim() === '') {
        input.value = '8';
        await flushCell(staffId, input.dataset.date, input);
      }
    }
    rowFillSnapshots[staffId] = snap;
  }
  renderHours();
}



document.getElementById('prevPeriodBtn').addEventListener('click', () => { periodStartVal -= PERIOD_DAYS * 86400000; loadAll(); });
document.getElementById('nextPeriodBtn').addEventListener('click', () => { periodStartVal += PERIOD_DAYS * 86400000; loadAll(); });
document.getElementById('todayBtn').addEventListener('click', () => { periodStartVal = periodStartValFor(todayVal()); loadAll(); });

// ---- Payroll Approval ----
function renderApprovalState() {
  updateApproveBtn(document.getElementById('approveWeek1Btn'), week1Approved, 'Week 1');
  updateApproveBtn(document.getElementById('approveWeek2Btn'), week2Approved, 'Week 2');
}
function updateApproveBtn(btn, approved, label) {
  if (!btn) return;
  if (approved) {
    btn.textContent = '✓ ' + label + ' Approved';
    btn.className = 'week-approve-btn approved';
  } else {
    btn.textContent = label + ' — Not Approved';
    btn.className = 'week-approve-btn unapproved';
  }
}

async function toggleApproval(weekNum) {
  const from = periodDates[0];
  const weekStart = weekNum === 1 ? from : periodDates[7];
  const isApproved = weekNum === 1 ? week1Approved : week2Approved;
  const btn = document.getElementById('approveWeek' + weekNum + 'Btn');
  btn.disabled = true;
  try {
    const sess = await ensureLoggedIn();
    const token = sess ? sess.access_token : SUPABASE_KEY;
    const authHdrs = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (isApproved) {
      const r = await fetch(REST + '/dgc_payroll_approval?period_start=eq.' + weekStart, { method: 'DELETE', headers: authHdrs });
      if (!r.ok) throw new Error(await r.text());
      if (weekNum === 1) week1Approved = false; else week2Approved = false;
      document.getElementById('hoursStatus').textContent = 'Week ' + weekNum + ' unlocked — hours can be edited';
    } else {
      const user = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } }).then(r => r.json()).catch(() => ({}));
      const approvedBy = user.email || 'PM';
      const r = await fetch(REST + '/dgc_payroll_approval', { method: 'POST', headers: { ...authHdrs, Prefer: 'return=representation' }, body: JSON.stringify({ period_start: weekStart, approved_by: approvedBy, approved_at: new Date().toISOString() }) });
      if (!r.ok) throw new Error(await r.text());
      if (weekNum === 1) week1Approved = true; else week2Approved = true;
      document.getElementById('hoursStatus').textContent = 'Week ' + weekNum + ' approved — accountants can pay ✓';
    }
    renderApprovalState();
    renderHours();
  } catch (e) {
    document.getElementById('hoursStatus').textContent = 'Failed — ' + e.message;
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('approveWeek1Btn').addEventListener('click', () => toggleApproval(1));
document.getElementById('approveWeek2Btn').addEventListener('click', () => toggleApproval(2));

// ---- Advances / Bonuses / Overtime ----
function updateAmountUnit() {
  const type = document.getElementById('advType').value;
  const amt = document.getElementById('advAmount');
  amt.placeholder = type === 'Overtime' ? 'Hours' : 'Amount £';
  amt.step = type === 'Overtime' ? '0.25' : '0.01';
}
document.getElementById('advType').addEventListener('change', updateAmountUnit);
document.getElementById('advDate').valueAsDate = new Date();

function renderAdvances() {
  const list = document.getElementById('advancesList');
  if (!advancesCache.length) { list.innerHTML = '<p class="hours-hint">Nothing logged this fortnight yet.</p>'; return; }
  list.innerHTML = advancesCache.map(a => {
    const s = staffById[a.staff_id];
    const typeCls = a.entry_type.toLowerCase();
    const amount = a.entry_type === 'Overtime' ? Number(a.amount) + 'h' : '£' + Number(a.amount).toFixed(2);
    return `<div class="advance-row">
      <div class="row-fields">
        <span class="advance-date">${fmtShort(a.entry_date)}</span>
        <span class="advance-name">${s ? s.name : '(unknown)'}</span>
        <span class="advance-type ${typeCls}">${a.entry_type}</span>
        <span class="advance-amount">${amount}</span>
        <span class="advance-notes">${a.notes || ''}</span>
      </div>
      <button class="advance-del-btn" data-table="dgc_staff_advances" data-id="${a.id}" title="Delete">&times;</button>
    </div>`;
  }).join('');
}

document.getElementById('advanceForm').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('advanceStatus');
  status.textContent = 'Saving…';
  try {
    await sbPost('dgc_staff_advances', {
      staff_id: document.getElementById('advStaff').value,
      entry_type: document.getElementById('advType').value,
      amount: Number(document.getElementById('advAmount').value),
      entry_date: document.getElementById('advDate').value,
      notes: document.getElementById('advNotes').value || null,
    });
    e.target.reset();
    document.getElementById('advDate').valueAsDate = new Date();
    updateAmountUnit();
    status.textContent = 'Added ✓';
    await loadAll();
  } catch (err) {
    status.textContent = 'Failed to save';
    console.error(err);
  }
});

// ---- Holidays & Leave ----
function weekdayCountClipped(fromIso, toIso) {
  const from = Math.max(valFromIso(fromIso), periodStartVal);
  const to = Math.min(valFromIso(toIso), addDaysVal(periodStartVal, PERIOD_DAYS - 1));
  let count = 0;
  for (let t = from; t <= to; t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}

function renderHolidays() {
  const list = document.getElementById('holidayList');
  const visible = leaveCache.filter(b => weekdayCountClipped(b.from_date, b.to_date) > 0);
  if (!visible.length) { list.innerHTML = '<p class="hours-hint">No bookings touching this fortnight.</p>'; return; }
  list.innerHTML = visible.map(b => {
    const s = staffById[b.staff_id];
    const days = weekdayCountClipped(b.from_date, b.to_date);
    const typeCls = b.leave_type === 'Holiday' ? 'bonus' : 'leave-type';
    const typeLabel = b.leave_type === 'Holiday' ? 'Paid' : 'Unpaid';
    return `<div class="advance-row">
      <div class="row-fields">
        <span class="advance-date">${fmtShort(b.from_date)} → ${fmtShort(b.to_date)}</span>
        <span class="advance-name">${s ? s.name : '(unknown)'}</span>
        <span class="advance-type ${typeCls}">${typeLabel}</span>
        <span class="advance-amount">${days}d</span>
        <span class="advance-notes">${b.notes || ''}</span>
      </div>
      <button class="advance-del-btn" data-table="dgc_staff_leave" data-id="${b.id}" title="Delete">&times;</button>
    </div>`;
  }).join('');
}

document.getElementById('holidayForm').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('holidayStatus');
  status.textContent = 'Saving…';
  try {
    await sbPost('dgc_staff_leave', {
      staff_id: document.getElementById('holStaff').value,
      leave_type: document.getElementById('holType').value,
      from_date: document.getElementById('holFrom').value,
      to_date: document.getElementById('holTo').value,
      notes: document.getElementById('holNotes').value || null,
    });
    e.target.reset();
    status.textContent = 'Added ✓';
    await loadAll();
  } catch (err) {
    status.textContent = 'Failed to save';
    console.error(err);
  }
});

document.addEventListener('click', async e => {
  if (!e.target.classList.contains('advance-del-btn')) return;
  if (!confirm('Delete this entry?')) return;
  const table = e.target.dataset.table;
  const id = e.target.dataset.id;
  await sbDelete(table, 'id=eq.' + id);
  await loadAll();
});

// ---- Export to Excel ----
async function buildWorkbook() {
  // Single dark-themed sheet per export containing:
  // DGC header → stats bar → hours grid (with Rate + Wages cols) → Advances & OT log → Holidays
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DGC Staff Tracker';

  // ── colour palette ──────────────────────────────────────────────────────────
  const BG       = 'FF0D1117', SURF  = 'FF161B22', SURF2  = 'FF1C2128';
  const TEXT_C   = 'FFE6EDF3', MUTED = 'FF8B949E', FAINT  = 'FF484F58';
  const H_BG     = 'FF0D2B1D', H_FG  = 'FF3FB950';
  const U_BG     = 'FF2D1F00', U_FG  = 'FFD29922';
  const NUM_FG   = 'FF58A6FF';
  const TOT_FG   = 'FFE6883C', OT_FG  = 'FFBC8CFF', ADV_FG  = 'FFD29922';
  const GROSS_FG = 'FFD4A72C';   // gold — gross (hours × rate)
  const NET_FG   = 'FF4AC26B';   // green — net pay (gross − advances)
  const TEAM_BG  = 'FF21262D', TEAM_FG = 'FFCDD9E5';
  const WKND_BG  = 'FF0A0F15', WKND_FG = 'FF3D444C';

  const fl = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
  const fo = (c, bold=false, italic=false, sz=10) => ({ color: { argb: c }, bold, italic, size: sz, name: 'Calibri' });
  const medBot  = { bottom: { style: 'medium', color: { argb: 'FF30363D' } } };
  const medTop  = { top:    { style: 'medium', color: { argb: 'FF30363D' } } };
  const thinBot = { bottom: { style: 'thin',   color: { argb: 'FF1C2128' } } };

  // ── column layout ───────────────────────────────────────────────────────────
  const dateLabels = periodDates.map(d => {
    const dt = new Date(d + 'T00:00:00');
    return `${dt.getDate()} ${dt.toLocaleString('en-GB', { month: 'short' })}`;
  });
  const isWknd = periodDates.map(d => { const day = new Date(d + 'T00:00:00').getDay(); return day === 0 || day === 6; });
  const N_DAYS   = periodDates.length;  // 14
  const OT_COL    = N_DAYS + 2;        // 16
  const TOT_COL   = N_DAYS + 3;        // 17
  const RATE_COL  = N_DAYS + 4;        // 18
  const GROSS_COL = N_DAYS + 5;        // 19 — hours × rate
  const ADV_COL   = N_DAYS + 6;        // 20 — advances taken
  const NET_COL   = N_DAYS + 7;        // 21 — gross − advances
  const LAST_COL  = NET_COL;           // 21

  // ── per-person wages ────────────────────────────────────────────────────────
  const advancesFor = id => advancesCache
    .filter(a => a.staff_id === id && a.entry_type === 'Advance')
    .reduce((s, a) => s + Number(a.amount), 0);
  const grossFor = id => {
    const s = staffById[id];
    const rate = s ? (Number(s.rate) || 0) : 0;
    return rowTotal(id) * rate;
  };
  const netFor = id => grossFor(id) - advancesFor(id);

  // ── summary stats ───────────────────────────────────────────────────────────
  const totalGross = staff.reduce((s, m) => s + grossFor(m.id), 0);
  const totalAdv   = staff.reduce((s, m) => s + advancesFor(m.id), 0);
  const totalNet   = staff.reduce((s, m) => s + netFor(m.id), 0);
  const otEntries  = advancesCache.filter(a => a.entry_type === 'Overtime').length;
  const onHoliday  = staff.filter(m => periodDates.some(d => { const c = cellFor(m.id, d); return c.kind === 'H' || c.kind === 'BH'; })).length;
  const unavail    = staff.filter(m => periodDates.some(d => cellFor(m.id, d).kind === 'U')).length;

  // ── sheet name ──────────────────────────────────────────────────────────────
  const from = periodDates[0], to = periodDates[N_DAYS - 1];
  const fromDt = new Date(from + 'T00:00:00');
  const toDt   = new Date(to   + 'T00:00:00');
  const sheetLabel = `${fromDt.getDate()} ${fromDt.toLocaleString('en-GB',{month:'short'})} - ${toDt.getDate()} ${toDt.toLocaleString('en-GB',{month:'short'})}`;

  const ws = wb.addWorksheet(sheetLabel);
  ws.views = [{}];

  // helper: fill a whole row with background
  const fillRow = (row, bg) => { row.eachCell({ includeEmpty: true }, cell => { cell.fill = fl(bg); }); };
  const fmt = v => '£' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // ── Try to load the DGC logo ─────────────────────────────────────────────────
  let logoId = null;
  try {
    const resp = await fetch('dgc_logo_white.png');
    if (resp.ok) {
      const blob = await resp.blob();
      const b64  = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload  = () => res(reader.result.replace(/^data:[^;]+;base64,/, ''));
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
      logoId = wb.addImage({ base64: b64, extension: 'png' });
    }
  } catch(e) { logoId = null; }

  const payDayStr = toDt.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });

  // ── header helper ─────────────────────────────────────────────────────────────
  // ExcelJS silently skips cells whose value is '' or ' ' (whitespace = empty).
  // Fix: use numeric 0 as the filler value with numFmt=';;;' (hides all display).
  // A number is NEVER treated as empty, so all 21 cells are guaranteed serialised.
  const HIDE = ';;;';  // Excel format that hides any value
  const hiddenCell = (cell, fillArgb) => {
    cell.value  = 0;
    cell.numFmt = HIDE;
    cell.fill   = fl(fillArgb);
    cell.font   = { color: { argb: fillArgb }, size: 1, name: 'Calibri' };
  };
  // Build a 21-element array of 0s (for addRow — forces all cells into sheetData)
  const zeros = () => new Array(LAST_COL).fill(0);

  // ── ROWS 1-4: dark header block ───────────────────────────────────────────────
  // Row 1: logo bar — all 21 cells explicitly created and filled dark
  const logoRow = ws.addRow(zeros());
  logoRow.height = 49;
  for (let ci = 1; ci <= LAST_COL; ci++) hiddenCell(logoRow.getCell(ci), BG);
  if (logoId !== null) {
    ws.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2.9, row: 4.0 } });
  }

  // Row 2: title left + pay-day right; no merge (merge kills the master cell in sheetData)
  const r2arr = zeros();
  const titleRow = ws.addRow(r2arr);
  titleRow.height = 20;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    const cell = titleRow.getCell(ci);
    if (ci === 1) {
      cell.value     = `STAFF HOURS  ·  ${sheetLabel} ${toDt.getFullYear()}`;
      cell.fill      = fl(BG);
      cell.font      = { color: { argb: MUTED }, size: 10, name: 'Calibri' };
      cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    } else if (ci === LAST_COL) {
      cell.value     = `Pay Day: ${payDayStr}`;
      cell.fill      = fl(BG);
      cell.font      = { color: { argb: MUTED }, size: 10, name: 'Calibri' };
      cell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    } else {
      hiddenCell(cell, BG);
    }
  }

  // Rows 3-4: pure dark filler
  for (let ri = 3; ri <= 4; ri++) {
    const fRow = ws.addRow(zeros());
    if (ri === 3) fRow.height = 20;
    for (let ci = 1; ci <= LAST_COL; ci++) hiddenCell(fRow.getCell(ci), BG);
  }

  // ── ROWS 5-6: stat labels + values (3 blocks; cols 12-21 dark fill) ──────────
  const statDefs = [
    { label: 'STAFF',     val: String(staff.length), fg: TEXT_C, bg: BG,    span: 3 },
    { label: 'NET WAGES', val: fmt(totalNet),          fg: NET_FG, bg: SURF2, span: 4 },
    { label: 'ADVANCES',  val: fmt(totalAdv),          fg: ADV_FG, bg: SURF2, span: 4 },
  ];

  const labRow = ws.addRow(zeros());
  labRow.height = 16;
  { let sc = 1;
    statDefs.forEach(({ label, fg, bg, span }) => {
      for (let ci = sc; ci < sc + span; ci++) {
        const cell = labRow.getCell(ci);
        if (ci === sc) {
          cell.value     = `  ${label}`;
          cell.fill      = fl(bg);
          cell.font      = { color: { argb: fg }, size: 8, name: 'Calibri' };
          cell.alignment = { horizontal: 'left', vertical: 'bottom', indent: 1 };
        } else {
          hiddenCell(cell, bg);
        }
      }
      sc += span;
    });
    for (let ci = 12; ci <= LAST_COL; ci++) hiddenCell(labRow.getCell(ci), SURF2);
  }

  const valRow = ws.addRow(zeros());
  valRow.height = 36;
  { let sc = 1;
    statDefs.forEach(({ val, fg, bg, span }) => {
      for (let ci = sc; ci < sc + span; ci++) {
        const cell = valRow.getCell(ci);
        if (ci === sc) {
          cell.value     = `  ${val}`;
          cell.fill      = fl(bg);
          cell.font      = { color: { argb: fg }, bold: true, size: 18, name: 'Calibri' };
          cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
        } else {
          hiddenCell(cell, bg);
        }
      }
      sc += span;
    });
    for (let ci = 12; ci <= LAST_COL; ci++) hiddenCell(valRow.getCell(ci), SURF2);
  }

  // ── ROW 7: legend ─────────────────────────────────────────────────────────────
  const legRow = ws.addRow(zeros());
  legRow.height = 16;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    const cell = legRow.getCell(ci);
    if (ci === 1) {
      cell.value     = '    H = Paid Holiday (8h)    ·    BH = Bank Holiday (8h)    ·    U = Unavailable    ·    [8] = Hours worked';
      cell.fill      = fl(SURF);
      cell.font      = { color: { argb: MUTED }, size: 8, name: 'Calibri' };
      cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
    } else {
      hiddenCell(cell, SURF);
    }
  }

  // ── ROW 8: thin separator ─────────────────────────────────────────────────────
  const sepRow = ws.addRow(zeros());
  sepRow.height = 6;
  for (let ci = 1; ci <= LAST_COL; ci++) hiddenCell(sepRow.getCell(ci), BG);

  // ── ROW 9: column headers ───────────────────────────────────────────────────
  const hdr = ws.addRow(['Name', ...dateLabels, 'OT (h)', 'Total Hrs', 'Rate', 'Gross', 'Advances', 'Net Pay']);
  hdr.height = 22;
  hdr.eachCell({ includeEmpty: true }, (cell, ci) => {
    const wk = ci >= 2 && ci < OT_COL && isWknd[ci - 2];
    cell.fill   = fl(BG);
    cell.border = medBot;
    cell.alignment = { horizontal: ci === 1 ? 'left' : 'center', vertical: 'middle' };
    cell.font =
      ci === 1         ? fo(TEXT_C,  true,  false, 9)
    : ci === OT_COL    ? fo(OT_FG,  true,  false, 9)
    : ci === TOT_COL   ? fo(TOT_FG, true,  false, 9)
    : ci === RATE_COL  ? fo(MUTED,  false, false, 9)
    : ci === GROSS_COL ? fo(GROSS_FG, true, false, 9)
    : ci === ADV_COL   ? fo(ADV_FG, true,  false, 9)
    : ci === NET_COL   ? fo(NET_FG, true,  false, 9)
    : wk               ? fo(FAINT,  false, false, 8)
    :                    fo(MUTED,  false, false, 9);
  });

  // ── staff rows ──────────────────────────────────────────────────────────────
  staff.forEach((s, idx) => {
    const dayVals = periodDates.map(date => {
      const c = cellFor(s.id, date);
      return c.kind === 'hours' ? Number(c.value) : (c.kind === 'weekend' || c.kind === 'blank') ? null : c.kind;
    });
    const ot    = overtimeFor(s.id);
    const tot   = rowTotal(s.id);
    const rate  = Number(s.rate) || 0;
    const gross = grossFor(s.id);
    const adv   = advancesFor(s.id);
    const net   = netFor(s.id);
    const row   = ws.addRow([s.name, ...dayVals, ot || null, tot || null, rate || null, gross || null, adv || null, net || null]);
    row.height  = 21;
    const rbg   = (idx % 2 === 0) ? SURF2 : SURF;

    row.eachCell({ includeEmpty: true }, (cell, ci) => {
      const di  = ci - 2;
      const isDay = ci >= 2 && ci < OT_COL;
      const wk    = isDay && isWknd[di];
      const v     = cell.value;
      cell.border = thinBot;
      cell.alignment = { horizontal: ci === 1 ? 'left' : 'center', vertical: 'middle' };

      if (ci === 1) {
        cell.fill = fl(rbg); cell.font = fo(TEXT_C, false, false, 10);
        cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      } else if (ci === GROSS_COL) {
        cell.fill = fl(rbg); cell.font = gross ? fo(GROSS_FG, true, false, 11) : fo(FAINT, false, false, 9);
        if (gross) cell.numFmt = '"£"#,##0.00';
        cell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
      } else if (ci === ADV_COL) {
        cell.fill = fl(rbg); cell.font = adv ? fo(ADV_FG, true, false, 11) : fo(FAINT, false, false, 9);
        if (adv) cell.numFmt = '"£"#,##0.00';
        cell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
      } else if (ci === NET_COL) {
        cell.fill = fl(rbg); cell.font = net ? fo(NET_FG, true, false, 11) : fo(FAINT, false, false, 9);
        if (net) cell.numFmt = '"£"#,##0.00';
        cell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
      } else if (ci === RATE_COL) {
        cell.fill   = fl(rbg); cell.font = fo(MUTED, false, false, 9);
        if (v) cell.numFmt = '"£"0.##';
      } else if (ci === TOT_COL) {
        cell.fill = fl(rbg); cell.font = fo(TOT_FG, true, false, 11);
        if (v) cell.numFmt = '0.##';
      } else if (ci === OT_COL) {
        cell.fill = fl(rbg); cell.font = ot ? fo(OT_FG, true, false, 10) : fo(FAINT, false, false, 9);
        if (ot) cell.numFmt = '0.##';
      } else if (v === 'H' || v === 'BH') {
        cell.fill = fl(H_BG); cell.font = fo(H_FG, true, false, 10);
      } else if (v === 'U') {
        cell.fill = fl(U_BG); cell.font = fo(U_FG, false, true, 10);
      } else if (typeof v === 'number' && v > 0) {
        cell.fill = fl(wk ? WKND_BG : rbg); cell.font = fo(NUM_FG, true, false, 10);
        cell.numFmt = '0.##';
      } else {
        cell.fill = fl(wk ? WKND_BG : rbg); cell.font = fo(wk ? WKND_FG : FAINT, false, false, 9);
        cell.value = null;
      }
    });
  });

  // ── TEAM TOTALS ─────────────────────────────────────────────────────────────
  const teamVals = ['TEAM TOTALS'];
  periodDates.forEach((date, di) => {
    let t = 0;
    staff.forEach(s => { const c = cellFor(s.id, date); if (c.kind === 'hours') t += Number(c.value)||0; else if (c.kind === 'BH'||c.kind === 'H') t += 8; });
    teamVals.push(t || null);
  });
  teamVals.push(staff.reduce((s, m) => s + overtimeFor(m.id), 0) || null);
  teamVals.push(staff.reduce((s, m) => s + rowTotal(m.id), 0) || null);
  teamVals.push(null);          // Rate col — no team rate
  teamVals.push(totalGross);    // Gross
  teamVals.push(totalAdv);      // Advances
  teamVals.push(totalNet);      // Net Pay

  const tr = ws.addRow(teamVals);
  tr.height = 28;
  tr.eachCell({ includeEmpty: true }, (cell, ci) => {
    const wk = ci >= 2 && ci < OT_COL && isWknd[ci - 2];
    const v  = cell.value;
    cell.fill = fl(TEAM_BG); cell.border = medTop;
    cell.alignment = { horizontal: ci === 1 ? 'left' : 'center', vertical: 'middle' };
    cell.font =
      ci === 1         ? fo(TEXT_C,   true,  false, 10)
    : ci === GROSS_COL ? fo(GROSS_FG, true,  false, 12)
    : ci === ADV_COL   ? fo(ADV_FG,  true,  false, 12)
    : ci === NET_COL   ? fo(NET_FG,  true,  false, 12)
    : ci === TOT_COL   ? fo(TOT_FG,  true,  false, 12)
    : ci === OT_COL    ? fo(OT_FG,   true,  false, 11)
    : wk               ? fo(FAINT,   false, false, 9)
    : v                ? fo(TEAM_FG, true,  false, 10)
    :                    fo(FAINT,   false, false, 9);
    if (v && ci > 1) {
      if (ci === GROSS_COL || ci === ADV_COL || ci === NET_COL) cell.numFmt = '"£"#,##0.00';
      else cell.numFmt = '0.##';
    }
    if (ci === GROSS_COL || ci === ADV_COL || ci === NET_COL)
      cell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
  });

  // ── separator ────────────────────────────────────────────────────────────────
  const sep1 = ws.addRow([]);
  sep1.height = 10;
  for (let ci = 1; ci <= LAST_COL; ci++) sep1.getCell(ci).fill = fl(BG);

  // ── ADVANCES & OT section ────────────────────────────────────────────────────
  const advSecRow = ws.addRow(['ADVANCES & OVERTIME']);
  advSecRow.height = 20;
  ws.mergeCells(advSecRow.number, 1, advSecRow.number, LAST_COL);
  advSecRow.getCell(1).fill      = fl(SURF2);
  advSecRow.getCell(1).font      = { color: { argb: OT_FG }, bold: true, size: 9, name: 'Calibri' };
  advSecRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  for (let ci = 2; ci <= LAST_COL; ci++) advSecRow.getCell(ci).fill = fl(SURF2);

  const advHdrPad = ['Date', '', 'Name', '', '', '', 'Type', '', '', '', 'Amount', '', '', 'Notes'];
  while (advHdrPad.length < LAST_COL) advHdrPad.push('');
  const advHdrRow = ws.addRow(advHdrPad);
  advHdrRow.height = 20;
  for (let ci = 1; ci <= LAST_COL; ci++) { const c = advHdrRow.getCell(ci); c.fill = fl(BG); c.border = thinBot; c.alignment = { horizontal: 'left', vertical: 'middle' }; c.font = fo(MUTED, true, false, 9); }
  ws.mergeCells(advHdrRow.number, 3, advHdrRow.number, 6);
  ws.mergeCells(advHdrRow.number, 7, advHdrRow.number, 10);
  ws.mergeCells(advHdrRow.number, 14, advHdrRow.number, LAST_COL);

  if (!advancesCache.length) {
    const nr = ws.addRow(['No advances or overtime logged this fortnight']);
    nr.height = 18;
    ws.mergeCells(nr.number, 1, nr.number, LAST_COL);
    nr.getCell(1).fill      = fl(SURF);
    nr.getCell(1).font      = fo(FAINT, false, true, 9);
    nr.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    for (let ci = 2; ci <= LAST_COL; ci++) nr.getCell(ci).fill = fl(SURF);
  } else {
    advancesCache.forEach((a, idx) => {
      const s     = staffById[a.staff_id];
      const rbg   = idx % 2 === 0 ? SURF2 : SURF;
      const isOT  = a.entry_type === 'Overtime';
      const isAdv = a.entry_type === 'Advance';
      const advPad = new Array(Math.max(0, LAST_COL - 14)).fill('');
      const row2  = ws.addRow([a.entry_date, '', s ? s.name : '(unknown)', '', '', '', a.entry_type, '', '', '', Number(a.amount), '', '', a.notes || '', ...advPad]);
      row2.height = 18;
      for (let ci = 1; ci <= LAST_COL; ci++) {
        const cell = row2.getCell(ci); cell.fill = fl(rbg); cell.border = thinBot;
        if (ci === 1) { cell.font = fo(MUTED, false, false, 9); cell.alignment = { horizontal: 'left', vertical: 'middle' }; if (a.entry_date) cell.numFmt = 'DD MMM'; }
        else if (ci === 3) { cell.font = fo(TEXT_C, false, false, 10); cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }; }
        else if (ci === 7) { cell.font = fo(isOT ? OT_FG : ADV_FG, true, false, 9); cell.alignment = { horizontal: 'left', vertical: 'middle' }; }
        else if (ci === 11) { cell.font = fo(isOT ? OT_FG : ADV_FG, true, false, 10); cell.numFmt = isAdv ? '"£"#,##0' : '0.##'; cell.alignment = { horizontal: 'right', vertical: 'middle' }; }
        else if (ci === 14) { cell.font = fo(FAINT, false, false, 9); cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }; }
      }
      ws.mergeCells(row2.number, 3, row2.number, 6);
      ws.mergeCells(row2.number, 7, row2.number, 10);
      ws.mergeCells(row2.number, 14, row2.number, LAST_COL);
    });
  }

  // ── HOLIDAYS section ─────────────────────────────────────────────────────────
  const sep2 = ws.addRow([]);
  sep2.height = 8;
  for (let ci = 1; ci <= LAST_COL; ci++) sep2.getCell(ci).fill = fl(BG);

  const holSecRow = ws.addRow(['HOLIDAYS & LEAVE']);
  holSecRow.height = 20;
  ws.mergeCells(holSecRow.number, 1, holSecRow.number, LAST_COL);
  holSecRow.getCell(1).fill      = fl(SURF2);
  holSecRow.getCell(1).font      = { color: { argb: H_FG }, bold: true, size: 9, name: 'Calibri' };
  holSecRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  for (let ci = 2; ci <= LAST_COL; ci++) holSecRow.getCell(ci).fill = fl(SURF2);

  // build a LAST_COL-wide blank row padded with empty strings
  const holHdrPad = ['From', 'To', 'Name', '', '', '', 'Type', '', '', '', 'Days', '', '', 'Notes'];
  while (holHdrPad.length < LAST_COL) holHdrPad.push('');
  const holHdrRow = ws.addRow(holHdrPad);
  holHdrRow.height = 20;
  for (let ci = 1; ci <= LAST_COL; ci++) { const c = holHdrRow.getCell(ci); c.fill = fl(BG); c.border = thinBot; c.alignment = { horizontal: 'left', vertical: 'middle' }; c.font = fo(MUTED, true, false, 9); }
  ws.mergeCells(holHdrRow.number, 3, holHdrRow.number, 6);
  ws.mergeCells(holHdrRow.number, 7, holHdrRow.number, 10);
  ws.mergeCells(holHdrRow.number, 14, holHdrRow.number, LAST_COL);

  if (!leaveCache.length) {
    const nr = ws.addRow(['No holiday bookings touching this fortnight']);
    nr.height = 18;
    ws.mergeCells(nr.number, 1, nr.number, LAST_COL);
    nr.getCell(1).fill      = fl(SURF);
    nr.getCell(1).font      = fo(FAINT, false, true, 9);
    nr.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    for (let ci = 2; ci <= LAST_COL; ci++) nr.getCell(ci).fill = fl(SURF);
  } else {
    leaveCache.forEach((b, idx) => {
      const s     = staffById[b.staff_id];
      const rbg   = idx % 2 === 0 ? SURF2 : SURF;
      const isHol = b.leave_type === 'Holiday';
      const isUnp = (b.leave_type || '').includes('Unpaid');
      const days  = weekdayCountClipped(b.from_date, b.to_date);
      const pad   = new Array(Math.max(0, LAST_COL - 14)).fill('');
      const row3  = ws.addRow([b.from_date, b.to_date, s ? s.name : '(unknown)', '', '', '', b.leave_type, '', '', '', days, '', '', b.notes || '', ...pad]);
      row3.height = 20;
      for (let ci = 1; ci <= LAST_COL; ci++) {
        const cell = row3.getCell(ci); cell.fill = fl(rbg); cell.border = thinBot;
        if (ci <= 2) { cell.font = fo(MUTED, false, false, 9); cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }; cell.numFmt = 'DD MMM'; }
        else if (ci === 3) { cell.font = fo(TEXT_C, false, false, 10); cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }; }
        else if (ci >= 7 && ci <= 10) { const typeBg = isHol ? H_BG : isUnp ? U_BG : rbg; cell.fill = fl(typeBg); if (ci === 7) { cell.font = fo(isHol ? H_FG : isUnp ? U_FG : MUTED, true, false, 9); cell.alignment = { horizontal: 'left', vertical: 'middle' }; } }
        else if (ci === 11) { cell.font = fo(NUM_FG, true, false, 10); cell.alignment = { horizontal: 'center', vertical: 'middle' }; }
        else if (ci === 14) { cell.font = fo(FAINT, false, false, 9); cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }; }
      }
      ws.mergeCells(row3.number, 3, row3.number, 6);
      ws.mergeCells(row3.number, 7, row3.number, 10);
      ws.mergeCells(row3.number, 14, row3.number, LAST_COL);
    });
  }

  // ── column widths ────────────────────────────────────────────────────────────
  ws.getColumn(1).width = 25;
  for (let i = 2; i <= N_DAYS + 1; i++) ws.getColumn(i).width = 6.2;
  ws.getColumn(OT_COL).width    = 7;
  ws.getColumn(TOT_COL).width   = 9;
  ws.getColumn(RATE_COL).width  = 7;
  ws.getColumn(GROSS_COL).width = 11;
  ws.getColumn(ADV_COL).width   = 11;
  ws.getColumn(NET_COL).width   = 12;

  return await wb.xlsx.writeBuffer();
}

// Remembers the exact file the user picked (Chrome/Edge only, via the File
// System Access API) so every later click overwrites that same file with no
// dialog — point it at a OneDrive-synced folder once and Microsoft's own
// sync does the "everyone else sees it" part, nothing extra needed here.
// Safari/Firefox don't support this API — they fall back to a plain download.
const FS_SUPPORTED = 'showSaveFilePicker' in window;
const HANDLE_DB = 'dgc-staff-tracker', HANDLE_STORE = 'handles', HANDLE_KEY = 'exportFile';

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getSavedHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}
async function saveHandle(handle) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
  } catch (e) { /* ignore — worst case it just asks again next time */ }
}
async function clearSavedHandle() {
  try {
    const db = await openHandleDB();
    db.transaction(HANDLE_STORE, 'readwrite').objectStore(HANDLE_STORE).delete(HANDLE_KEY);
  } catch (e) { /* ignore */ }
}
function updateExportUI(handle) {
  document.getElementById('exportBtn').textContent = handle ? `Save to ${handle.name}` : 'Export to Excel';
  document.getElementById('exportChangeBtn').hidden = !handle;
}

let exportInFlight = false;
document.getElementById('exportBtn').addEventListener('click', async () => {
  // Guard against a double-click or a second click before the first write's
  // close() resolves — two concurrent writes to the same handle is exactly
  // how you get a corrupted .xlsx that Excel refuses to open.
  if (exportInFlight) return;
  exportInFlight = true;
  const btn = document.getElementById('exportBtn');
  const prevLabel = btn.textContent;
  btn.disabled = true;

  const from = periodDates[0], to = periodDates[PERIOD_DAYS - 1];
  const suggestedName = `Staff Hours ${from} to ${to}.xlsx`;
  const status = document.getElementById('hoursStatus');
  status.textContent = 'Building styled Excel…';
  status.className = 'form-status';
  const buffer = await buildWorkbook();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  try {
    if (!FS_SUPPORTED) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = suggestedName; a.click();
      URL.revokeObjectURL(url);
      status.textContent = 'Downloaded — ' + new Date().toLocaleTimeString('en-GB');
      status.className = 'form-status success';
      return;
    }

    let handle = await getSavedHandle();
    if (handle) {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') handle = null;
    }
    if (!handle) {
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Excel Workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
      });
      await saveHandle(handle);
      updateExportUI(handle);
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    status.textContent = 'Saved to ' + handle.name + ' — ' + new Date().toLocaleTimeString('en-GB');
    status.className = 'form-status success';
  } catch (e) {
    if (e.name !== 'AbortError') {
      status.textContent = 'Export failed — try again';
      console.error(e);
    }
  } finally {
    exportInFlight = false;
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
});

document.getElementById('exportChangeBtn').addEventListener('click', async () => {
  await clearSavedHandle();
  updateExportUI(null);
});

(async () => {
  if (FS_SUPPORTED) {
    const h = await getSavedHandle();
    if (h) updateExportUI(h);
  } else {
    document.getElementById('exportChangeBtn').hidden = true;
  }
})();

// auth.js calls loadAll() after successful login.

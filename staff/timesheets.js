// DGC Timesheets — PM view of all worker-submitted daily hours
// Reads from dgc_timesheets table (populated by worker app)
// Requires authenticated session — redirects to index.html if not logged in

const REST = SUPABASE_URL + '/rest/v1';
let session = null;
let records = [];
let weekOffset = 0; // 0 = this week, -1 = last week, etc.
let refreshTimer = null;

function ah(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + session.access_token,
    'Content-Type': 'application/json',
  }, extra || {});
}

// ── Week range ────────────────────────────────────────────────────────────────
function getWeekRange(offset) {
  const now = new Date();
  const dow = now.getDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now);
  mon.setDate(now.getDate() - daysFromMon + offset * 7);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmtShort = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return {
    start: mon.toISOString().slice(0, 10),
    end: sun.toISOString().slice(0, 10),
    label: 'Week ending ' + fmtShort(sun),
  };
}

// ── Collapsed state (per person, persisted) ───────────────────────────────────
function getCollapsedState() {
  try { return JSON.parse(localStorage.getItem('dgc_ts_collapsed') || '{}'); } catch { return {}; }
}
function setPersonCollapsed(name, isCollapsed) {
  const state = getCollapsedState();
  state[name] = isCollapsed; // true = collapsed, false = explicitly open
  try { localStorage.setItem('dgc_ts_collapsed', JSON.stringify(state)); } catch {}
}

// ── Data ──────────────────────────────────────────────────────────────────────
async function loadData() {
  const { start, end } = getWeekRange(weekOffset);
  const r = await fetch(
    REST + '/dgc_timesheets?select=id,staff_name,work_date,site,description,notes,hours,start_time,finish_time,lunch_mins' +
    '&work_date=gte.' + start + '&work_date=lte.' + end + '&order=staff_name.asc,work_date.asc',
    { headers: ah() }
  );
  if (!r.ok) throw new Error(await r.text());
  records = await r.json();
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtHours(h) {
  const total = Math.round(parseFloat(h || 0) * 60);
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  return mins === 0 ? hrs + 'h' : hrs + 'h ' + mins + 'm';
}
function initials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (name || '?').slice(0, 2).toUpperCase();
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  const inIframe = window.self !== window.top;
  const { label } = getWeekRange(weekOffset);
  const collapsed = getCollapsedState();

  const headerHtml = `
    <header class="topbar" style="position:sticky;top:0">
      <h1 style="margin:0;font-size:1rem">Timesheets</h1>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="prevWeekBtn" class="secondary-btn" style="padding:7px 12px;font-size:1rem">&#8249;</button>
        <span id="weekLabel" style="font-size:0.9rem;color:var(--text);white-space:nowrap;min-width:180px;text-align:center">${label}</span>
        <button id="nextWeekBtn" class="secondary-btn" style="padding:7px 12px;font-size:1rem" ${weekOffset >= 0 ? 'disabled style="opacity:0.4;cursor:default;padding:7px 12px;font-size:1rem"' : ''}>&#8250;</button>
        <button id="refreshBtn" class="secondary-btn">Refresh</button>
        ${inIframe ? '' : '<button id="logoutBtn" class="secondary-btn">Sign out</button>'}
      </div>
    </header>`;

  if (records.length === 0) {
    app.innerHTML = headerHtml + `<p style="padding:32px;text-align:center;color:var(--muted)">No timesheet entries for this week.</p>`;
    bindControls();
    return;
  }

  // Group by person
  const byPerson = {};
  for (const rec of records) {
    if (!byPerson[rec.staff_name]) byPerson[rec.staff_name] = [];
    byPerson[rec.staff_name].push(rec);
  }

  let bodyHtml = '<div style="padding:16px;display:flex;flex-direction:column;gap:12px">';

  for (const [name, entries] of Object.entries(byPerson)) {
    const inits = initials(name);
    const totalHours = entries.reduce((s, e) => s + parseFloat(e.hours || 0), 0);
    const isCollapsed = collapsed[name] !== false; // collapsed by default; only open if explicitly set to false

    let entriesHtml = '';
    for (const e of entries) {
      const timing = [e.start_time, e.finish_time].filter(Boolean).join(' – ');
      entriesHtml += `
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:${e.description ? '8px' : '0'}">
            <div style="min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:0.8rem;color:var(--muted)">${fmtDate(e.work_date)}</span>
                <span style="font-weight:700;font-size:0.95rem">${e.site || '—'}</span>
              </div>
              ${timing ? `<div style="font-size:0.78rem;color:var(--muted);margin-top:2px">${timing}${e.lunch_mins ? ' · ' + e.lunch_mins + 'm lunch' : ''}</div>` : ''}
            </div>
            <div style="flex-shrink:0;text-align:right">
              <div style="font-size:1.1rem;font-weight:700;color:var(--accent)">${fmtHours(e.hours)}</div>
            </div>
          </div>
          ${e.description ? `<div style="font-size:0.9rem;color:var(--text);background:var(--panel2);border-left:3px solid var(--accent);padding:8px 12px;border-radius:0 6px 6px 0;line-height:1.45">${e.description}</div>` : ''}
          ${e.notes ? `<div style="font-size:0.8rem;color:var(--muted);font-style:italic;margin-top:6px">Note: ${e.notes}</div>` : ''}
        </div>`;
    }

    bodyHtml += `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden">
        <div class="ts-person-hdr" data-name="${name.replace(/"/g,'&quot;')}"
          style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:var(--panel2);cursor:pointer;user-select:none">
          <span style="width:38px;height:38px;border-radius:50%;background:#1b2a3b;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.9rem;flex-shrink:0">${inits}</span>
          <span style="font-weight:600;font-size:1rem;flex:1">${name}</span>
          <span style="color:var(--accent);font-weight:700;font-size:0.9rem">${fmtHours(totalHours)}</span>
          <span class="ts-chevron" style="color:var(--muted);font-size:0.9rem;transition:transform 0.2s;transform:rotate(${isCollapsed ? '0deg' : '90deg'})">&rsaquo;</span>
        </div>
        <div class="ts-person-body" data-name="${name.replace(/"/g,'&quot;')}" style="display:${isCollapsed ? 'none' : 'block'}">
          ${entriesHtml}
        </div>
      </div>`;
  }

  bodyHtml += '</div>';
  app.innerHTML = headerHtml + bodyHtml;
  bindControls();
}

// ── Event binding ─────────────────────────────────────────────────────────────
function bindControls() {
  const lb = document.getElementById('logoutBtn');
  if (lb) lb.addEventListener('click', () => logout());

  document.getElementById('refreshBtn').addEventListener('click', () => refresh());

  document.getElementById('prevWeekBtn').addEventListener('click', () => {
    weekOffset--;
    refresh();
  });
  const nextBtn = document.getElementById('nextWeekBtn');
  if (nextBtn && weekOffset < 0) {
    nextBtn.addEventListener('click', () => {
      weekOffset++;
      refresh();
    });
  }

}

// Fix: event delegation needs to persist across renders without accumulating
// We attach once per render using a re-bound approach
let _collapseHandler = null;
function bindCollapse() {
  const container = document.getElementById('app');
  if (_collapseHandler) container.removeEventListener('click', _collapseHandler);
  _collapseHandler = e => {
    const hdr = e.target.closest('.ts-person-hdr');
    if (!hdr) return;
    const name = hdr.dataset.name;
    const body = document.querySelector(`.ts-person-body[data-name="${CSS.escape(name)}"]`);
    const chevron = hdr.querySelector('.ts-chevron');
    if (!body) return;
    const nowCollapsed = body.style.display === 'none';
    body.style.display = nowCollapsed ? 'block' : 'none';
    if (chevron) chevron.style.transform = nowCollapsed ? 'rotate(90deg)' : 'rotate(0deg)';
    setPersonCollapsed(name, !nowCollapsed);
  };
  container.addEventListener('click', _collapseHandler);
}

async function refresh() {
  // Re-check session on every refresh — access token expires after 1 hour
  const fresh = await ensureLoggedIn();
  if (!fresh) { window.location.replace('index.html'); return; }
  session = fresh;
  try {
    await loadData();
    render();
    bindCollapse();
  } catch (err) {
    const app = document.getElementById('app');
    // Replace content rather than appending so errors don't stack up
    app.innerHTML = `<p style="color:var(--danger);padding:16px">Error loading timesheets — try refreshing the page.<br><small style="opacity:.6">${err.message}</small></p>`;
  }
}

function scheduleAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 60000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const app = document.getElementById('app');
  session = await ensureLoggedIn();
  if (!session) { window.location.replace('index.html'); return; }
  try {
    await loadData();
    render();
    bindCollapse();
    scheduleAutoRefresh();
  } catch (err) {
    app.innerHTML = `<div style="padding:24px;color:#f85149">Error loading timesheets: ${err.message}</div>`;
  }
})();

// DGC Staff Tracker — Add Staff
// Matches the local Staff Tracker UI: initials avatars, skill tags,
// three-dot status menu, full edit modal overlay, search, and
// "No Longer Working Here" toggle.

const REST = SUPABASE_URL + '/rest/v1';
let session = null;
let staffList = [];
let showLeft = false;

const SKILLS = [
  'Groundworker', 'Skilled Labourer', 'Unskilled Labourer',
  'Digger Driver (Competent)', 'Digger Driver (Not Confident)',
  'Building Works', 'Concrete', 'Drainage', 'Management', 'NRV',
];

const DEFAULT_MANAGERS = [
  'John Mcloughlin',
  'Andy Wynne-Smythe',
  'Stephen Lamb',
  'James Cosgrove',
  'Bradley Mckevitt',
];

function getManagers() {
  try {
    const extra = JSON.parse(localStorage.getItem('dgc_line_managers_extra') || '[]');
    return [...DEFAULT_MANAGERS, ...extra];
  } catch { return [...DEFAULT_MANAGERS]; }
}

function addManager(name) {
  try {
    const extra = JSON.parse(localStorage.getItem('dgc_line_managers_extra') || '[]');
    if (!extra.includes(name)) {
      extra.push(name);
      localStorage.setItem('dgc_line_managers_extra', JSON.stringify(extra));
    }
  } catch {}
}

const AVATAR_COLORS = [
  '#1a6b3a','#1a4d6b','#6b3a1a','#6b1a4d','#3a6b1a','#4d1a6b','#6b4d1a','#1a6b6b',
];

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbGet(path, anon) {
  const headers = anon ? { apikey: SUPABASE_KEY } : authedHeaders(session);
  const r = await fetch(REST + path, { headers });
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function initials(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?')[0].toUpperCase();
}

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function skillTags(skills) {
  if (!skills) return '';
  return skills.split(',').map(s => s.trim()).filter(Boolean)
    .map(s => `<span class="skill-tag">${s}</span>`).join('');
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Load + render ─────────────────────────────────────────────────────────────
async function loadStaff() {
  try {
    // Try with profile join; fall back to staff-only if profile table missing
    // dgc_staff RLS allows anon reads only — always use anon key
    try {
      staffList = await sbGet('/dgc_staff?select=*,dgc_staff_profile(*)&order=name', false);
    } catch {
      staffList = (await sbGet('/dgc_staff?select=*&order=name', true))
        .map(s => ({ ...s, dgc_staff_profile: null }));
    }
    renderList();
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div style="padding:24px;color:#f85149">Error loading staff: ${err.message}</div>`;
  }
}

function renderList() {
  const app  = document.getElementById('app');
  const term = (document.getElementById('staffSearch')?.value || '').toLowerCase();

  let list = staffList.filter(p => {
    const status = p.status || (p.active ? 'Working' : 'Left');
    return showLeft ? status === 'Left' : status !== 'Left';
  });
  if (term) list = list.filter(p => p.name.toLowerCase().includes(term));

  // Working first, then Off Work
  const working = list.filter(p => (p.status || 'Working') === 'Working');
  const offWork = list.filter(p => (p.status || '') === 'Off Work');
  list = [...working, ...offWork];

  app.innerHTML = `
    <header class="topbar" style="position:static">
      <h1 style="margin:0">Add Staff</h1>
      <button id="toggleLeftBtn" class="secondary-btn" style="font-size:12px">${showLeft ? 'Active Staff' : 'Ex-Staff'}</button>
      <button id="logoutBtn" class="secondary-btn" style="margin-left:8px;font-size:12px">Sign out</button>
    </header>
    <div style="padding:16px;max-width:900px">
      <div style="display:flex;gap:10px;margin-bottom:14px;align-items:center">
        <input id="staffSearch" type="search" placeholder="Search by name…"
          style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:0.9rem"
          value="${escHtml(term)}">
        <button id="addPersonBtn" class="primary-btn">+ Add Person</button>
      </div>

      <div id="staffListEl" class="staff-list">
        ${list.length ? list.map(p => renderRow(p)).join('') : '<p class="empty-msg">Nobody here yet.</p>'}
      </div>
    </div>

    <!-- Quick-view overlay -->
    <div id="quickOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;align-items:center;justify-content:center;padding:20px">
      <div id="quickBox" style="background:#161b22;border:1px solid #30363d;border-radius:12px;width:100%;max-width:420px;padding:24px"></div>
    </div>

    <!-- Modal overlay -->
    <div id="modalOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;overflow-y:auto;padding:24px 0">
      <div id="modalBox" style="background:#161b22;border:1px solid #30363d;border-radius:12px;max-width:680px;margin:0 auto;padding:28px 28px 24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <h2 id="modalTitle" style="margin:0;font-size:1.1rem">Edit Person</h2>
          <button id="closeModal" style="background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer;line-height:1">&times;</button>
        </div>
        <div id="editHolidaySection" style="display:none;margin-bottom:16px">
          <div style="text-transform:uppercase;font-size:0.7rem;letter-spacing:0.08em;color:var(--accent);margin-bottom:4px">Holiday Balance</div>
          <p id="editHolidayInfo" style="color:var(--muted);font-size:0.85rem;margin:0"></p>
        </div>
        <form id="addForm">
          ${buildFormSections()}
          <p id="formStatus" class="form-status" style="margin-top:12px"></p>
          <div style="display:flex;gap:10px;margin-top:16px">
            <button type="submit" id="saveFormBtn" class="primary-btn">Save Changes</button>
            <button type="button" id="closeModal2" class="secondary-btn">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Status menus are appended to rows dynamically -->`;

  // Wire events
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('toggleLeftBtn').addEventListener('click', () => {
    showLeft = !showLeft;
    renderList();
  });
  document.getElementById('staffSearch').addEventListener('input', renderList);
  document.getElementById('addPersonBtn').addEventListener('click', () => openModal(null));
  document.getElementById('closeModal').addEventListener('click', closeModal);
  document.getElementById('closeModal2').addEventListener('click', closeModal);
  document.getElementById('addForm').addEventListener('submit', saveForm);

  // Line manager dropdown — show text input when "Add someone new..." is chosen
  const lmSel = document.querySelector('[name="line_manager"]');
  const newMgrBox = document.getElementById('newManagerBox');
  lmSel.addEventListener('change', () => {
    newMgrBox.style.display = lmSel.value === '__new__' ? 'block' : 'none';
  });
  document.getElementById('addManagerBtn').addEventListener('click', () => {
    const input = document.getElementById('newManagerInput');
    const nm = input.value.trim();
    if (!nm) return;
    addManager(nm);
    const opt = new Option(nm, nm);
    lmSel.insertBefore(opt, lmSel.querySelector('[value="__new__"]'));
    lmSel.value = nm;
    newMgrBox.style.display = 'none';
    input.value = '';
  });

  // Staff rows — click name opens quick-view card
  document.querySelectorAll('.staff-row-name').forEach(el => {
    el.addEventListener('click', () => {
      const p = staffList.find(x => x.id === el.closest('[data-id]').dataset.id);
      if (p) openQuickView(p);
    });
  });
  document.querySelectorAll('.menu-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.status-menu').forEach(m => m.remove());
      const p = staffList.find(x => x.id === btn.dataset.id);
      if (!p) return;
      const menu = document.createElement('div');
      menu.className = 'status-menu';
      menu.style.cssText = 'position:absolute;right:0;top:100%;background:#1c2128;border:1px solid #30363d;border-radius:8px;z-index:100;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.5)';
      menu.innerHTML = `
        <button data-status="Working" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:var(--text);text-align:left;cursor:pointer">In / Working</button>
        <button data-status="Off Work" data-off-type="Holiday" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:var(--text);text-align:left;cursor:pointer">Off Work &ndash; Holiday (H, paid)</button>
        <button data-status="Off Work" data-off-type="Leave" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:var(--text);text-align:left;cursor:pointer">Off Work &ndash; Leave (L, unpaid)</button>
        <button data-status="Left" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f85149;text-align:left;cursor:pointer">Delete (no longer working)</button>`;
      menu.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', async e => {
          e.stopPropagation(); // prevent layout-shift click from reaching name handler
          const status    = b.dataset.status;
          const offType   = b.dataset.offType || null;
          const newActive = status !== 'Left';
          menu.remove();
          try {
            await sbPatch('dgc_staff', 'id=eq.' + p.id, { status, off_work_type: offType, active: newActive });
            await loadStaff();
          } catch (err) {
            alert('Error: ' + err.message);
          }
        });
      });
      const row = btn.closest('[data-id]');
      row.style.position = 'relative';
      row.appendChild(menu);
    });
  });

  // Outside-click closes any open status menu — named fn so it's never added twice
  document.removeEventListener('click', _closeStatusMenus);
  document.addEventListener('click', _closeStatusMenus);
}

function _closeStatusMenus(e) {
  if (!e.target.closest('.status-menu') && !e.target.closest('.menu-btn')) {
    document.querySelectorAll('.status-menu').forEach(m => m.remove());
  }
}

function renderRow(p) {
  const status   = p.status || (p.active ? 'Working' : 'Left');
  const offType  = p.off_work_type || '';
  const isOff    = status === 'Off Work';
  const color    = avatarColor(p.name);
  const ini      = initials(p.name);
  const skills   = p.skills || (p.dgc_staff_profile && p.dgc_staff_profile.skills) || '';

  let badge = '';
  if (isOff && offType === 'Holiday') badge = '<span class="badge-offwork badge-holiday">OFF WORK &middot; H</span>';
  else if (isOff && offType === 'Leave') badge = '<span class="badge-offwork badge-leave">OFF WORK &middot; L</span>';
  else if (isOff) badge = '<span class="badge-offwork">OFF WORK</span>';

  return `
    <div class="list-row ${isOff ? 'off-work' : ''}" data-id="${p.id}">
      <div class="avatar-sm avatar-placeholder-sm" style="background:${color};flex-shrink:0;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;color:#fff;margin-right:10px">${ini}</div>
      <div class="row-main staff-row-name" style="cursor:pointer">
        <div class="row-name">${escHtml(p.name)}</div>
      </div>
      <div class="row-role">${escHtml(p.role || '')}</div>
      <div class="row-skills">${skillTags(skills)}</div>
      <div class="row-spacer"></div>
      <button class="menu-btn" data-id="${p.id}" style="background:none;border:none;color:var(--muted);font-size:1.2rem;cursor:pointer;padding:4px 8px;line-height:1">&#8942;</button>
    </div>`;
}

// ── Quick-view card ───────────────────────────────────────────────────────────
function fmtDateDisplay(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB');
}

function openQuickView(person) {
  const pr      = person.dgc_staff_profile || {};
  const status  = person.status || (person.active ? 'Working' : 'Left');
  const isOff   = status === 'Off Work';
  const offType = person.off_work_type || '';
  const color   = avatarColor(person.name);
  const ini     = initials(person.name);

  const statusLabel  = isOff ? `OFF WORK${offType ? ' · ' + offType[0].toUpperCase() : ''}` : 'WORKING';
  const statusColor  = isOff ? '#f85149' : '#3fb950';
  const statusBg     = isOff ? 'rgba(217,83,79,0.15)' : 'rgba(56,139,58,0.15)';
  const statusBorder = isOff ? 'rgba(217,83,79,0.4)' : 'rgba(56,139,58,0.4)';

  const stat = (label, val) => `
    <div>
      <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">${label}</div>
      <div style="font-size:0.95rem">${val || '—'}</div>
    </div>`;

  document.getElementById('quickBox').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px">
      <div style="width:52px;height:52px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;color:#fff;flex-shrink:0">${ini}</div>
      <div style="min-width:0">
        <div style="font-size:1.15rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(person.name)}</div>
        <div style="color:var(--muted);font-size:0.85rem">${escHtml(person.role || '')}</div>
      </div>
      <div style="margin-left:auto;flex-shrink:0;position:relative" id="statusWrap">
        <button id="statusChipBtn" style="background:${statusBg};color:${statusColor};border:1px solid ${statusBorder};border-radius:6px;padding:3px 10px;font-size:0.75rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;font-family:inherit">
          ${statusLabel} <span style="font-size:0.6rem;opacity:0.7">&#9660;</span>
        </button>
        <div id="statusDropdown" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--panel2);border:1px solid var(--border);border-radius:8px;overflow:hidden;z-index:200;min-width:150px;box-shadow:0 6px 20px rgba(0,0,0,0.35)">
          <button class="sdrop-opt" data-s="Working" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;color:#3fb950;font-size:0.88rem;font-weight:600;cursor:pointer;font-family:inherit">Working</button>
          <button class="sdrop-opt" data-s="Holiday" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;color:var(--text);font-size:0.88rem;cursor:pointer;font-family:inherit">Holiday</button>
          <button class="sdrop-opt" data-s="Extended Leave" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;color:var(--text);font-size:0.88rem;cursor:pointer;font-family:inherit">Extended Leave</button>
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px;padding:16px;background:var(--panel2);border-radius:8px">
      ${stat('Date of Birth', fmtDateDisplay(pr.dob))}
      ${stat('Phone', escHtml(pr.phone))}
      <div>
        <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">Pay Rate</div>
        <div style="font-size:1.05rem;font-weight:700;color:var(--accent)">${person.rate ? '£' + person.rate + '/hr' : '—'}</div>
      </div>
      ${stat('Start Date', fmtDateDisplay(person.start_date))}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="editFullBtn" class="secondary-btn" style="flex:1">Edit Profile</button>
      <button id="closeQuickBtn" class="secondary-btn">Close</button>
    </div>
    <p id="quickStatus" style="margin:8px 0 0;font-size:0.85rem;color:var(--muted);min-height:1em"></p>`;

  document.getElementById('quickOverlay').style.display = 'flex';

  // Status chip dropdown
  const chipBtn  = document.getElementById('statusChipBtn');
  const dropdown = document.getElementById('statusDropdown');

  chipBtn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });

  // Hover highlight for dropdown options
  dropdown.querySelectorAll('.sdrop-opt').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--border)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', async () => {
      const choice = btn.dataset.s;
      dropdown.style.display = 'none';
      chipBtn.textContent = 'Updating…';
      chipBtn.disabled = true;
      const patch = choice === 'Working'
        ? { status: 'Working', off_work_type: null, active: true }
        : { status: 'Off Work', off_work_type: choice, active: false };
      try {
        await sbPatch('dgc_staff', 'id=eq.' + person.id, patch);
        closeQuickView();
        await loadStaff();
      } catch (err) {
        document.getElementById('quickStatus').textContent = 'Error: ' + err.message;
        chipBtn.disabled = false;
        chipBtn.textContent = statusLabel;
      }
    });
  });

  // Close dropdown on outside click
  const outsideClose = e => {
    if (!document.getElementById('statusWrap')?.contains(e.target)) {
      dropdown.style.display = 'none';
      document.removeEventListener('click', outsideClose);
    }
  };
  document.addEventListener('click', outsideClose);

  document.getElementById('closeQuickBtn').addEventListener('click', () => {
    document.removeEventListener('click', outsideClose);
    closeQuickView();
  });
  document.getElementById('editFullBtn').addEventListener('click', () => {
    document.removeEventListener('click', outsideClose);
    closeQuickView();
    openModal(person);
  });
}

function closeQuickView() {
  document.getElementById('quickOverlay').style.display = 'none';
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let editingId = null;

function openModal(person) {
  editingId = person ? person.id : null;
  const form    = document.getElementById('addForm');
  const overlay = document.getElementById('modalOverlay');
  const status  = document.getElementById('formStatus');
  form.reset();
  document.getElementById('newManagerBox').style.display = 'none';
  status.textContent = ''; status.className = 'form-status';

  if (person) {
    document.getElementById('modalTitle').textContent = `Edit ${person.name}`;
    document.getElementById('saveFormBtn').textContent = 'Save Changes';
    // Fill fields from dgc_staff
    setVal('role', person.role);
    setVal('start_date', person.start_date);
    setVal('rate', person.rate);
    // Fill from profile if available
    const pr = person.dgc_staff_profile || {};
    ['gender','marital_status','dob','phone','email','address',
     'contracted_hours','pay_type','line_manager','contract_date','ni_number','tax_number',
     'work_permit_number','visa_required','bank_name','bank_branch','account_name',
     'sort_code','account_number','next_of_kin','medical_conditions','bio','notes','skills_other'
    ].forEach(f => setVal(f, pr[f]));
    // If the saved line_manager isn't in the select options, add it and save it
    const lmSel = document.querySelector('[name="line_manager"]');
    const lmVal = pr['line_manager'];
    if (lmVal && lmSel && !Array.from(lmSel.options).some(o => o.value === lmVal)) {
      const opt = new Option(lmVal, lmVal);
      lmSel.insertBefore(opt, lmSel.querySelector('[value="__new__"]'));
      addManager(lmVal);
    }
    if (lmVal && lmSel) lmSel.value = lmVal;
    // First/last name: prefer the profile's split name, but most staff were bulk-imported
    // with just a single "name" field and no profile row at all — fall back to splitting
    // dgc_staff.name so the form never opens with the name fields blank.
    if (pr.first_name || pr.surname) {
      setVal('first_name', pr.first_name);
      setVal('surname', pr.surname);
    } else {
      const parts = (person.name || '').trim().split(/\s+/);
      setVal('first_name', parts[0] || '');
      setVal('surname', parts.slice(1).join(' '));
    }
    // Skills checkboxes
    const skillsVal = person.skills || pr.skills || '';
    const skillSet = skillsVal.split(',').map(s => s.trim()).filter(Boolean);
    form.querySelectorAll('[name="skills"]').forEach(cb => { cb.checked = skillSet.includes(cb.value); });
    // Holiday balance (best effort)
    const holSection = document.getElementById('editHolidaySection');
    holSection.style.display = 'block';
    document.getElementById('editHolidayInfo').textContent = 'Loading…';
    // Fetch leave and compute balance
    (async () => {
      try {
        const ah = authedHeaders(session);
        const year = new Date().getFullYear();
        const r = await fetch(`${REST}/dgc_staff_leave?staff_id=eq.${person.id}&select=leave_type,from_date,to_date`, { headers: ah });
        const leaves = r.ok ? await r.json() : [];
        const IOM_BH = new Set(['2026-01-01','2026-04-03','2026-04-06','2026-05-04','2026-05-25','2026-06-12','2026-07-06','2026-08-31','2026-12-25','2026-12-28']);
        function isWD(ds) { const d = new Date(ds+'T12:00:00'); return d.getDay()!==0&&d.getDay()!==6&&!IOM_BH.has(ds); }
        function wdRange(a,b) { let n=0,d=new Date(a+'T12:00:00'),e=new Date(b+'T12:00:00'); while(d<=e){if(isWD(d.toISOString().slice(0,10)))n++;d.setDate(d.getDate()+1);} return n; }
        const sd = person.start_date;
        if (!sd) { document.getElementById('editHolidayInfo').textContent = 'No start date — holiday balance unavailable.'; return; }
        const ent = sd.slice(0,4) < String(year) ? 22 : Math.ceil(22 * wdRange(sd, `${year}-12-31`) / wdRange(`${year}-01-01`, `${year}-12-31`) * 2) / 2;
        const today = new Date().toISOString().slice(0,10);
        const ysStart = sd.slice(0,4) < String(year) ? `${year}-01-01` : sd;
        const accrued = Math.min(ent, Math.round(ent * wdRange(ysStart, today) / wdRange(ysStart, `${year}-12-31`) * 10) / 10);
        const taken = leaves.filter(l=>l.leave_type==='Holiday').reduce((s,l) => {
          const f = l.from_date < `${year}-01-01` ? `${year}-01-01` : l.from_date;
          const t = l.to_date > `${year}-12-31` ? `${year}-12-31` : l.to_date;
          return f > t ? s : s + wdRange(f, t);
        }, 0);
        const forced = ['2026-06-08','2026-06-09','2026-06-10','2026-06-11','2026-12-29','2026-12-30','2026-12-31'].filter(d=>d.startsWith(String(year))&&d>=sd).length;
        const remain = Math.round((accrued - taken - forced) * 10) / 10;
        const col = remain <= 0 ? '#ef4444' : remain <= 3 ? '#f97316' : '#22c55e';
        document.getElementById('editHolidayInfo').innerHTML =
          `Entitlement: <b>${ent}</b> days &nbsp;|&nbsp; Accrued: <b>${accrued}</b> &nbsp;|&nbsp; Taken: <b>${taken}</b> &nbsp;|&nbsp; Forced: <b>${forced}</b> &nbsp;|&nbsp; Remaining: <b style="color:${col}">${remain}</b> &nbsp;— <a href="holiday-tracker.html" target="_top" style="color:#f59e0b">Full tracker</a>`;
      } catch(e) { document.getElementById('editHolidayInfo').textContent = 'Could not load holiday data.'; }
    })();
  } else {
    document.getElementById('modalTitle').textContent = 'Add Person';
    document.getElementById('saveFormBtn').textContent = 'Save & Add';
    document.getElementById('editHolidaySection').style.display = 'none';
    form.querySelector('[name="skills"][value="Groundworker"]').checked = true;
  }

  overlay.style.display = 'block';
  overlay.scrollTop = 0;

  // Media upload section
  const fileListArea  = document.getElementById('fileListArea');
  const uploadInput   = document.getElementById('fileUploadInput');
  const uploadStatus  = document.getElementById('uploadStatus');

  if (editingId) {
    loadStaffFiles(editingId);
    uploadInput.onchange = async () => {
      const files = Array.from(uploadInput.files);
      if (!files.length) return;
      uploadStatus.textContent = `Uploading ${files.length} file(s)…`;
      let ok = 0, fail = 0;
      for (const f of files) {
        try {
          await uploadStaffFile(editingId, f);
          ok++;
        } catch { fail++; }
      }
      uploadInput.value = '';
      uploadStatus.textContent = fail ? `${ok} uploaded, ${fail} failed` : `${ok} uploaded ✓`;
      setTimeout(() => { uploadStatus.textContent = ''; }, 3000);
      loadStaffFiles(editingId);
    };
  } else {
    fileListArea.innerHTML = '<p style="font-size:0.82rem;color:var(--muted);margin:0">Save this profile first, then open Edit to attach files.</p>';
    uploadInput.onchange = null;
  }
}

// ── Supabase Storage helpers ──────────────────────────────────────────────────
const STORAGE = SUPABASE_URL + '/storage/v1';
const BUCKET  = 'staff-media';

async function uploadStaffFile(staffId, file) {
  const path = `${staffId}/${Date.now()}_${file.name}`;
  const r = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: authedHeaders(session).apikey || SUPABASE_KEY,
      Authorization: authedHeaders(session).Authorization,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!r.ok) throw new Error(await r.text());
  return path;
}

async function listStaffFiles(staffId) {
  const r = await fetch(`${STORAGE}/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...authedHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: `${staffId}/`, limit: 100, sortBy: { column: 'created_at', order: 'desc' } }),
  });
  if (!r.ok) return [];
  const items = await r.json();
  return items.filter(f => f.name && !f.name.endsWith('/'));
}

async function getSignedUrl(path) {
  const r = await fetch(`${STORAGE}/object/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...authedHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.signedURL ? (STORAGE + data.signedURL) : null;
}

async function deleteStaffFile(path) {
  const r = await fetch(`${STORAGE}/object/${BUCKET}/${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: authedHeaders(session),
  });
  return r.ok;
}

async function loadStaffFiles(staffId) {
  const area = document.getElementById('fileListArea');
  if (!area) return;
  area.innerHTML = '<p style="font-size:0.82rem;color:var(--muted);margin:0">Loading files…</p>';
  try {
    const files = await listStaffFiles(staffId);
    if (!files.length) {
      area.innerHTML = '<p style="font-size:0.82rem;color:var(--muted);margin:0">No files attached yet.</p>';
      return;
    }
    area.innerHTML = files.map(f => {
      const displayName = f.name.replace(/^\d+_/, '');
      const fullPath    = `${staffId}/${f.name}`;
      const isImage     = /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name);
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--panel2);border:1px solid var(--border);border-radius:6px">
        <span style="font-size:1rem">${isImage ? '🖼' : '📄'}</span>
        <span style="flex:1;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(displayName)}">${escHtml(displayName)}</span>
        <button class="file-view-btn secondary-btn" data-path="${escHtml(fullPath)}" style="font-size:0.78rem;padding:4px 10px">View</button>
        <button class="file-del-btn secondary-btn" data-path="${escHtml(fullPath)}" style="font-size:0.78rem;padding:4px 10px;color:#f85149;border-color:rgba(217,83,79,0.4)">✕</button>
      </div>`;
    }).join('');

    area.querySelectorAll('.file-view-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.textContent = '…';
        const url = await getSignedUrl(btn.dataset.path);
        btn.textContent = 'View';
        if (url) window.open(url, '_blank');
        else alert('Could not open file. Try again.');
      });
    });
    area.querySelectorAll('.file-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this file?')) return;
        btn.disabled = true;
        await deleteStaffFile(btn.dataset.path);
        loadStaffFiles(staffId);
      });
    });
  } catch (err) {
    area.innerHTML = `<p style="font-size:0.82rem;color:#f85149;margin:0">Error loading files: ${err.message}</p>`;
  }
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  editingId = null;
}

function setVal(name, val) {
  const el = document.getElementById('addForm').elements[name];
  if (el && val != null) el.value = val;
}

async function saveForm(e) {
  e.preventDefault();
  const status = document.getElementById('formStatus');
  const btn    = document.getElementById('saveFormBtn');
  status.textContent = 'Saving…'; status.className = 'form-status';
  btn.disabled = true;

  const fd = new FormData(document.getElementById('addForm'));
  const firstName  = (fd.get('first_name') || '').trim();
  const surname    = (fd.get('surname')    || '').trim();
  const name       = [firstName, surname].filter(Boolean).join(' ');
  const role       = fd.get('role') || null;
  const start_date = fd.get('start_date') || null;
  const rate       = fd.get('rate') ? Number(fd.get('rate')) : null;
  const skillsArr  = fd.getAll('skills');
  const other      = (fd.get('skills_other') || '').trim();
  if (other) skillsArr.push(other);
  const skills = skillsArr.join(', ');

  try {
    let staffId = editingId;
    if (editingId) {
      await sbPatch('dgc_staff', 'id=eq.' + editingId, { name, role, start_date, rate, skills });
    } else {
      const [row] = await sbPost('dgc_staff', { name, role, start_date, rate, skills, active: true, status: 'Working' });
      staffId = row.id;
    }

    // Build profile payload
    const profileFields = ['first_name','surname','gender','marital_status','dob','phone','email','address',
      'contracted_hours','pay_type','line_manager','contract_date','ni_number','tax_number',
      'work_permit_number','visa_required','bank_name','bank_branch','account_name',
      'sort_code','account_number','next_of_kin','medical_conditions','bio','notes','skills_other'];
    const profile = { staff_id: staffId, skills };
    profileFields.forEach(f => { profile[f] = fd.get(f) || null; });

    // Try to upsert profile (table may not exist yet — ignore error)
    try {
      await fetch(REST + '/dgc_staff_profile?on_conflict=staff_id', {
        method: 'POST',
        headers: authedHeaders(session, { Prefer: 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify(profile),
      });
    } catch { /* profile table not created yet */ }

    status.textContent = 'Saved ✓'; status.className = 'form-status success';
    await loadStaff();
    setTimeout(closeModal, 700);
  } catch (err) {
    status.textContent = 'Error: ' + err.message; status.className = 'form-status error';
    btn.disabled = false;
  }
}

// ── Form HTML ─────────────────────────────────────────────────────────────────
function buildFormSections() {
  const field = (label, name, type='text', opts='') =>
    `<label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted)">
      ${label}
      <input name="${name}" type="${type}" ${opts}
        style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem">
    </label>`;

  const grid2 = (...fields) =>
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${fields.join('')}</div>`;

  const section = (title, content) =>
    `<div style="margin-bottom:20px">
      <div style="text-transform:uppercase;font-size:0.7rem;letter-spacing:0.08em;color:var(--accent);margin-bottom:12px">${title}</div>
      ${content}
    </div>`;

  const skillCheckboxes = SKILLS.map(s =>
    `<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer">
      <input type="checkbox" name="skills" value="${s}"> ${s}
    </label>`).join('');

  return `
    ${section('Basics', `
      ${grid2(field('First name(s)', 'first_name'), field('Surname', 'surname'))}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${field('Gender', 'gender')}
        ${field('Marital status', 'marital_status')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${field('Date of birth', 'dob', 'date')}
        ${field('Job title / role', 'role')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${field('Phone', 'phone', 'tel')}
        ${field('Email', 'email', 'email')}
      </div>
      <div style="margin-top:12px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted)">
          Address
          <textarea name="address" rows="2"
            style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem;resize:vertical"></textarea>
        </label>
      </div>
    `)}

    ${section('Employment', `
      ${grid2(field('Start date', 'start_date', 'date'), field('Contracted hours', 'contracted_hours'))}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${field('Pay rate (£/hr)', 'rate', 'number')}
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted)">
          Pay type
          <select name="pay_type" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem">
            <option value=""></option>
            <option>Hourly</option><option>PAYE</option><option>CIS</option><option>Self-employed</option>
          </select>
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted)">
          Line manager
          <select name="line_manager" style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem">
            <option value=""></option>
            ${getManagers().map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('')}
            <option value="__new__">+ Add someone new...</option>
          </select>
          <div id="newManagerBox" style="display:none;margin-top:6px">
            <div style="display:flex;gap:6px">
              <input id="newManagerInput" type="text" placeholder="Full name"
                style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:7px 10px;color:var(--text);font-size:0.9rem">
              <button type="button" id="addManagerBtn" class="secondary-btn" style="font-size:0.85rem">Add</button>
            </div>
          </div>
        </label>
        ${field('Contract date', 'contract_date', 'date')}
      </div>
    `)}

    ${section('Statutory / ID', `
      ${grid2(field('NI number', 'ni_number'), field('Tax ID number', 'tax_number'))}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${field('Work permit number', 'work_permit_number')}
        ${field('Visa required?', 'visa_required')}
      </div>
    `)}

    ${section('Bank Details', `
      ${grid2(field('Bank name', 'bank_name'), field('Bank branch', 'bank_branch'))}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${field('Account name', 'account_name')}
        ${field('Sort code', 'sort_code')}
      </div>
      <div style="margin-top:12px">${field('Account number', 'account_number')}</div>
    `)}

    ${section('Next of Kin & Health', `
      ${grid2(field('Next of kin (name & phone)', 'next_of_kin'), field('Medical conditions / allergies', 'medical_conditions'))}
    `)}

    ${section('Skills', `
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">${skillCheckboxes}</div>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted)">
        Other skill
        <input name="skills_other" placeholder="anything not listed above"
          style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted);margin-top:12px">
        Bio — qualifications, strengths, notes
        <textarea name="bio" rows="3" placeholder="e.g. CSCS card, 5 years groundworks, good with plant machinery…"
          style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem;resize:vertical"></textarea>
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;color:var(--muted);margin-top:12px">
        Notes
        <textarea name="notes" rows="2"
          style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:var(--text);font-size:0.9rem;resize:vertical"></textarea>
      </label>
    `)}

    ${section('Documents &amp; Photos', `
      <div id="fileListArea" style="margin-bottom:10px;display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label id="fileUploadLabel" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:8px 16px;font-size:0.85rem;color:var(--text)">
          + Attach Files
          <input id="fileUploadInput" type="file" multiple accept="image/*,.pdf,.doc,.docx,.heic,.heif" style="display:none">
        </label>
        <span id="uploadStatus" style="font-size:0.82rem;color:var(--muted)"></span>
      </div>
      <p style="margin:8px 0 0;font-size:0.78rem;color:var(--muted)">Photos, trade cards, certificates, documents (JPG, PNG, PDF, HEIC)</p>
    `)}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const app = document.getElementById('app');
  session = await ensureLoggedIn();
  if (!session) { window.location.replace('index.html'); return; }
  await loadStaff();
})();

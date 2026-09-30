// Job Planner notifications bell (v2.87), modelled on Trello's.
// Reads dgc_planner_activity, which database triggers fill in: one line per
// person, per job (or column), per day, holding where it started the day and
// where it is now. Rules agreed with Ash (30 Sep 2026):
//  - only other people's changes (never your own)
//  - a change shows once that person has left it alone for 5 minutes
//  - if it ends up back where it started, it doesn't show at all
//  - today open, the previous 7 days folded away underneath
//  - unread is remembered on your login, so it follows you between devices
(function () {
  const SETTLE_MS = 5 * 60 * 1000;
  const DAYS_BACK = 8;
  const NAMES = {
    'ash@dgc.im': 'Ash', 'ash@silverdale.im': 'Ash', 'harry@dgc.im': 'Harry',
    'john.mcloughlin@dgc.im': 'John McLoughlin', 'andy.w.smythe@dgc.im': 'Andy Wynne-Smythe',
    'india.christian@silverdale.im': 'India Christian', 'info@dgc.im': 'Office (info@)',
  };
  const AUTO = 'Job Planner';
  let rows = [], me = '', seenAt = '', readKeys = [], onlyUnread = false, earlierOpen = false, started = false;

  const who = e => NAMES[(e || '').toLowerCase()] || (e || 'Someone').split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const key = r => r.id + '@' + r.last_at;
  const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Isle_of_Man' });
  const hm = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Isle_of_Man' });
  const dayLabel = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const fd = d => (d && typeof fmtDate === 'function') ? fmtDate(d) : (d || '?');
  const len = s => { const t = (s.base_weeks || 0) * 5 + (s.base_days || 0); const w = Math.floor(t / 5), d = t % 5; return (w ? w + 'w' : '') + (d ? (w ? ' ' : '') + d + 'd' : '') || '0d'; };

  function place(s) {
    if (!s) return '';
    if (s.archived) return 'Archive';
    const board = (typeof _board !== 'undefined' && _board) || [];
    if (s.board_col) { const c = board.find(x => x.id === s.board_col); return c ? c.title : 'a column that was deleted'; }
    const st = s.status === 'confirmed' ? 'awarded' : s.status;
    const c = board.find(x => x.status === st);
    return c ? c.title : ((typeof STATUS_LBL !== 'undefined' && STATUS_LBL[s.status]) || s.status || '?');
  }

  // Automatic Awarded -> Running on the start date: the Planner did it, not the person whose screen was open
  function isAutoStart(r) {
    const b = r.before, a = r.after;
    if (r.kind !== 'job' || !b || !a) return false;
    if (!['awarded', 'confirmed'].includes(b.status) || a.status !== 'running' || !a.start_date || a.start_date > r.day) return false;
    return Object.keys(a).every(k => k === 'status' || same(a[k], b[k]));
  }

  function changes(r) {
    const b = r.before, a = r.after;
    if (r.kind === 'column') {
      if (!b) return [`added the column "${a.title}"`];
      if (!a) return [`deleted the column "${b.title}"`];
      const out = [];
      if (b.title !== a.title) out.push(`renamed the column "${b.title}" to "${a.title}"`);
      if (b.color !== a.color) out.push(`changed the colour of "${a.title}"`);
      if (b.pos !== a.pos && !out.length) out.push('rearranged the columns');
      return out;
    }
    if (!b) return [`added this job, starting ${fd(a.start_date)}, ${len(a)}, ${a.people_needed || 0} guys`];
    if (!a) return ['deleted this job'];
    const out = [];
    if (!b.archived && a.archived) out.push('marked it complete and archived it');
    if (b.archived && !a.archived) out.push('restored it from the archive');
    if (b.name !== a.name) out.push(`renamed it from "${b.name}"`);
    if (b.start_date !== a.start_date) out.push(`moved the start from ${fd(b.start_date)} to ${fd(a.start_date)}`);
    if (len(b) !== len(a)) out.push(`changed the length from ${len(b)} to ${len(a)}`);
    if (!a.archived && !b.archived && place(b) !== place(a)) out.push(`moved it from ${place(b)} to ${place(a)}`);
    if ((b.on_timeline !== false) !== (a.on_timeline !== false)) out.push(a.on_timeline === false ? 'took it off the timeline' : 'put it on the timeline');
    if ((b.people_on_site || 0) !== (a.people_on_site || 0)) out.push(`changed guys on site from ${b.people_on_site || 0} to ${a.people_on_site || 0}`);
    if ((b.people_needed || 0) !== (a.people_needed || 0)) out.push(`changed guys needed from ${b.people_needed || 0} to ${a.people_needed || 0}`);
    if (!same(b.day_overrides || [], a.day_overrides || [])) out.push('changed the crew on some days');
    if ((b.note || '') !== (a.note || '')) out.push('edited the notes');
    return out;
  }

  // Rows worth showing: settled, not mine, a real net change. Column reshuffles
  // by one person on one day collapse into a single "rearranged" line.
  function visible() {
    const cut = Date.now() - SETTLE_MS, oldest = new Date(Date.now() - DAYS_BACK * 864e5).toISOString().slice(0, 10);
    const out = [], shuffles = {};
    for (const r0 of rows) {
      // Extra days going from "not saved yet" to a number is the one-off copy
      // from someone's browser onto the job, not a real change: ignore it.
      const r = (r0.kind === 'job' && r0.before && r0.after && r0.before.base_days == null)
        ? { ...r0, before: { ...r0.before, base_days: r0.after.base_days } } : r0;
      if (r.day < oldest || new Date(r.last_at).getTime() > cut || same(r.before, r.after)) continue;
      const auto = isAutoStart(r);
      if (!auto && (r.actor || '').toLowerCase() === me) continue;
      const lines = auto ? ['started today, so it moved to Running'] : changes(r);
      if (!lines.length) continue;
      if (r.kind === 'column' && lines.length === 1 && lines[0] === 'rearranged the columns') {
        const k = r.day + '|' + r.actor;
        if (shuffles[k]) { shuffles[k].keys.push(key(r)); if (r.last_at > shuffles[k].last_at) shuffles[k].last_at = r.last_at; continue; }
        shuffles[k] = { ...r, lines, auto, keys: [key(r)], title: 'Board columns' };
        out.push(shuffles[k]);
        continue;
      }
      out.push({ ...r, lines, auto, keys: [key(r)] });
    }
    return out.sort((x, y) => y.last_at.localeCompare(x.last_at));
  }
  const isUnread = v => v.last_at > (seenAt || '') && !v.keys.every(k => readKeys.includes(k));

  async function saveSeen() {
    const s = getStoredSession(); if (!s) return;
    const keep = new Set(rows.map(key));
    readKeys = readKeys.filter(k => keep.has(k)).slice(-400);
    try { await fetch(SUPABASE_URL + '/auth/v1/user', { method: 'PUT', headers: authedHeaders(s), body: JSON.stringify({ data: { dgc_bell_seen: seenAt, dgc_bell_read: readKeys } }) }); } catch (e) {}
  }

  async function load() {
    if (typeof _sb === 'undefined' || !_sb) return;
    const since = new Date(Date.now() - DAYS_BACK * 864e5).toISOString().slice(0, 10);
    const { data, error } = await _sb.from('dgc_planner_activity').select('*').gte('day', since).order('last_at', { ascending: false }).limit(500);
    if (error) { rows = []; paint(); document.getElementById('bell-btn')?.setAttribute('data-off', /does not exist|42P01/.test(error.message) ? '1' : ''); return; }
    rows = data || [];
    paint();
  }

  function paint() {
    const btn = document.getElementById('bell-btn');
    if (!btn) return;
    const vis = visible(), unread = vis.filter(isUnread).length;
    const badge = btn.querySelector('.bell-badge');
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread ? '' : 'none';
    btn.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    const panel = document.getElementById('bell-panel');
    if (panel && panel.classList.contains('open')) renderPanel(vis);
  }

  function itemHtml(v) {
    const job = v.kind === 'job' && typeof _jobs !== 'undefined' ? (_jobs || []).find(j => String(j.id) === String(v.item_id)) : null;
    const snap = v.after || v.before || {};
    const col = v.kind === 'job' ? ((typeof STATUS_COL !== 'undefined' && STATUS_COL[snap.status]) || '#94a3b8') : (snap.color || '#94a3b8');
    const name = v.auto ? AUTO : who(v.actor);
    const title = v.title || (v.kind === 'column' ? 'Board column: ' + (snap.title || v.item_name) : (v.item_name || snap.name || 'Job'));
    const unread = isUnread(v);
    return `<li class="bell-item${unread ? ' unread' : ''}" data-keys="${esc(v.keys.join(' '))}" ${job && !job.archived ? `data-job="${esc(job.id)}"` : ''}>
      <div class="bell-card" style="--bc:${col}"><span class="bell-card-name">${esc(title)}</span>${job ? `<span class="bell-card-where">${esc(place(job))}</span>` : (v.kind === 'job' && !v.after ? '<span class="bell-card-where">Deleted</span>' : '')}</div>
      <div class="bell-row">
        <span class="bell-av${v.auto ? ' auto' : ''}" aria-hidden="true">${v.auto ? '⚙' : esc(initials(name))}</span>
        <div class="bell-text"><b>${esc(name)}</b> ${v.lines.map(esc).join('; ')}
          <div class="bell-time">${v.day === todayIso() ? 'Today' : dayLabel(v.day)} at ${hm(v.last_at)}</div></div>
        <button type="button" class="bell-dot" title="${unread ? 'Mark as read' : 'Read'}" aria-label="${unread ? 'Mark as read' : 'Read'}" ${unread ? '' : 'disabled'}></button>
      </div>
    </li>`;
  }

  function renderPanel(vis) {
    const panel = document.getElementById('bell-panel');
    const list = onlyUnread ? vis.filter(isUnread) : vis;
    const t = todayIso();
    const today = list.filter(v => v.day === t), earlier = list.filter(v => v.day !== t);
    const off = document.getElementById('bell-btn').getAttribute('data-off') === '1';
    const byDay = {};
    earlier.forEach(v => (byDay[v.day] = byDay[v.day] || []).push(v));
    panel.querySelector('.bell-body').innerHTML = off
      ? '<p class="bell-empty">Notifications aren\'t switched on yet. Ask Claude to finish the set-up.</p>'
      : `<div class="bell-sec">Today</div>
        ${today.length ? `<ul class="bell-list">${today.map(itemHtml).join('')}</ul>` : `<p class="bell-empty">${onlyUnread ? 'Nothing unread today.' : 'No changes by anyone else today.'}</p>`}
        ${earlier.length ? `<button type="button" class="bell-earlier" aria-expanded="${earlierOpen}">${earlierOpen ? '▾' : '▸'} Earlier this week (${earlier.length})</button>
          ${earlierOpen ? Object.keys(byDay).sort().reverse().map(d => `<div class="bell-sec">${esc(dayLabel(d))}</div><ul class="bell-list">${byDay[d].map(itemHtml).join('')}</ul>`).join('') : ''}` : ''}`;
    panel.querySelector('#bell-unread-only').checked = onlyUnread;
  }

  function openJob(id) {
    const j = (_jobs || []).find(x => String(x.id) === String(id));
    if (!j) return;
    const tl = document.querySelector('.nav button');
    if (tl && !document.getElementById('tab-timeline').classList.contains('active')) showTab('timeline', tl);
    if (typeof openEdit === 'function') openEdit(j);
  }

  function build() {
    const slot = document.querySelector('.hdr-r');
    if (!slot || document.getElementById('bell-btn')) return;
    const st = document.createElement('style');
    st.textContent = `
    .bell-wrap{position:relative;display:flex}
    #bell-btn{position:relative;background:none;border:1px solid rgba(255,255,255,.18);border-radius:6px;color:#cbd5e1;width:32px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
    #bell-btn:hover{border-color:var(--accent);color:var(--accent)}
    #bell-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    #bell-btn svg{width:16px;height:16px}
    .bell-badge{position:absolute;top:-7px;right:-8px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:800;line-height:17px;text-align:center;box-sizing:border-box;box-shadow:0 0 0 2px #0f1a2a}
    #bell-panel{position:fixed;top:52px;right:12px;width:380px;max-width:calc(100vw - 24px);max-height:calc(100vh - 70px);display:none;flex-direction:column;background:var(--surf);color:var(--text);border:1px solid var(--bord);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.35);z-index:9600;overflow:hidden}
    #bell-panel.open{display:flex}
    .bell-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 8px;border-bottom:1px solid var(--bord)}
    .bell-head h2{margin:0;font-size:14px;font-weight:800}
    .bell-close{background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px}
    .bell-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;border-bottom:1px solid var(--bord);font-size:12px;color:var(--muted)}
    .bell-tools label{display:flex;align-items:center;gap:6px;cursor:pointer}
    .bell-markall{background:none;border:none;color:var(--accent);font-weight:700;font-size:12px;cursor:pointer;padding:0;font-family:inherit}
    .bell-body{overflow-y:auto;padding:4px 0 10px}
    .bell-sec{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:10px 14px 4px}
    .bell-list{list-style:none;margin:0;padding:0 8px}
    .bell-item{padding:8px 6px;border-radius:8px;cursor:default}
    .bell-item[data-job]{cursor:pointer}
    .bell-item[data-job]:hover{background:var(--surf2)}
    .bell-card{display:flex;align-items:baseline;justify-content:space-between;gap:8px;background:var(--surf2);border-left:4px solid var(--bc);border-radius:5px;padding:6px 9px;margin-bottom:6px}
    .bell-card-name{font-weight:800;font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bell-card-where{font-size:10.5px;color:var(--muted);white-space:nowrap}
    .bell-row{display:flex;gap:8px;align-items:flex-start}
    .bell-av{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:#3b82f6;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center}
    .bell-av.auto{background:#64748b;font-size:13px}
    .bell-text{flex:1;min-width:0;font-size:12.5px;line-height:1.4}
    .bell-time{font-size:11px;color:var(--muted);margin-top:2px}
    .bell-dot{flex-shrink:0;width:12px;height:12px;border-radius:50%;border:2px solid var(--bord);background:none;margin-top:6px;padding:0;cursor:default}
    .bell-item.unread .bell-dot{background:#3b82f6;border-color:#3b82f6;cursor:pointer}
    .bell-empty{font-size:12.5px;color:var(--muted);padding:6px 14px;margin:0}
    .bell-earlier{display:block;width:calc(100% - 16px);margin:10px 8px 0;text-align:left;background:none;border:1px solid var(--bord);border-radius:7px;padding:8px 10px;color:var(--text);font-weight:700;font-size:12px;cursor:pointer;font-family:inherit}
    @media (max-width:600px){#bell-panel{top:48px;right:8px;left:8px;width:auto}}`;
    document.head.appendChild(st);

    const wrap = document.createElement('div');
    wrap.className = 'bell-wrap';
    wrap.innerHTML = `<button type="button" id="bell-btn" aria-haspopup="dialog" aria-label="Notifications" title="Notifications">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        <span class="bell-badge" style="display:none">0</span></button>`;
    slot.insertBefore(wrap, slot.firstChild);

    const panel = document.createElement('div');
    panel.id = 'bell-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Notifications');
    panel.innerHTML = `<div class="bell-head"><h2>Notifications</h2><button type="button" class="bell-close" aria-label="Close">×</button></div>
      <div class="bell-tools"><label><input type="checkbox" id="bell-unread-only"> Only show unread</label><button type="button" class="bell-markall">Mark all as read</button></div>
      <div class="bell-body"></div>`;
    document.body.appendChild(panel);

    const btn = wrap.querySelector('#bell-btn');
    const close = () => { panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.classList.toggle('open')) { btn.setAttribute('aria-expanded', 'true'); renderPanel(visible()); load(); }
      else close();
    });
    panel.querySelector('.bell-close').addEventListener('click', close);
    document.addEventListener('click', e => { if (panel.classList.contains('open') && !panel.contains(e.target) && !wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) { close(); btn.focus(); } });
    panel.querySelector('#bell-unread-only').addEventListener('change', e => { onlyUnread = e.target.checked; renderPanel(visible()); });
    panel.querySelector('.bell-markall').addEventListener('click', () => {
      const vis = visible();
      seenAt = vis.reduce((m, v) => v.last_at > m ? v.last_at : m, seenAt || '');
      readKeys = []; paint(); renderPanel(visible()); saveSeen();
    });
    panel.addEventListener('click', e => {
      const more = e.target.closest('.bell-earlier');
      if (more) { earlierOpen = !earlierOpen; renderPanel(visible()); return; }
      const li = e.target.closest('.bell-item');
      if (!li) return;
      const keys = li.dataset.keys.split(' ');
      const wasUnread = li.classList.contains('unread');
      if (wasUnread) { keys.forEach(k => { if (!readKeys.includes(k)) readKeys.push(k); }); paint(); renderPanel(visible()); saveSeen(); }
      if (e.target.closest('.bell-dot')) return;
      if (li.dataset.job) { close(); openJob(li.dataset.job); }
    });
  }

  window.dgcBellStart = async function () {
    if (started) return;
    started = true;
    build();
    const s = getStoredSession();
    me = ((s && s.email) || (typeof _sessEmail === 'function' ? _sessEmail(s) : '') || '').toLowerCase();
    try {
      const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: authedHeaders(s) });
      if (r.ok) {
        const u = await r.json();
        me = (u.email || me).toLowerCase();
        seenAt = (u.user_metadata && u.user_metadata.dgc_bell_seen) || '';
        readKeys = (u.user_metadata && u.user_metadata.dgc_bell_read) || [];
        // First time: only what happens from now on counts as unread
        if (!seenAt) { seenAt = new Date().toISOString(); saveSeen(); }
      }
    } catch (e) {}
    await load();
    if (_sb) _sb.channel('plan-activity').on('postgres_changes', { event: '*', schema: 'public', table: 'dgc_planner_activity' }, () => load()).subscribe();
    setInterval(() => { if (document.visibilityState === 'visible') paint(); }, 30000);   // 5-minute settle passes
    setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  };
})();

// "Suggest a change" button + pop-up. Sends a Trello card to the AHP board
// INBOX via the Supabase Edge Function `suggest-change` (the Trello key and
// token live only in that function's secrets, never in this public page).
// Include on any page: <script src="../planner/suggest-change.js"></script>
(function () {
  if (window.top !== window.self) return; // inside the planner's iframes: the planner's own button covers it
  if (window.__dgcSuggest) return;
  window.__dgcSuggest = true;

  const SB_URL = 'https://vigdtpcgeqenznuakdwz.supabase.co';
  const SB_KEY = 'sb_publishable_nUG65QtsU2p1-hWpdUuaSQ_bF4G1EGQ';
  const FN_URL = SB_URL + '/functions/v1/suggest-change';
  const SESSION_KEY = 'dgc_auth_session';

  function session() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }
  async function freshSession() {
    if (typeof window.ensureLoggedIn === 'function') {
      try { return await window.ensureLoggedIn(); } catch (e) { /* fall through */ }
    }
    let s = session();
    if (!s) return null;
    if (Date.now() < s.expires_at) return s;
    const r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    s = { access_token: d.access_token, refresh_token: d.refresh_token,
          expires_at: Date.now() + (d.expires_in - 60) * 1000, email: (d.user && d.user.email) || s.email };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    return s;
  }
  function pageName() {
    const tab = document.querySelector('.nav button.active');
    return (document.title || location.pathname) + (tab ? ' › ' + tab.textContent.trim() : '');
  }

  const css = `
  .sgc-btn{background:none;border:1px solid rgba(245,158,11,.55);border-radius:6px;color:#f59e0b;font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer;font-family:inherit;letter-spacing:.02em;white-space:nowrap}
  .sgc-btn:hover{background:rgba(245,158,11,.12)}
  .sgc-btn:focus-visible{outline:2px solid #f59e0b;outline-offset:2px}
  .sgc-float{position:fixed;top:10px;right:190px;z-index:9000;background:rgba(15,17,23,.85)}
  .sgc-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:none;align-items:center;justify-content:center;padding:16px}
  .sgc-back.open{display:flex}
  .sgc-box{width:100%;max-width:460px;background:#1a1d27;color:#e2e8f0;border:1px solid #2e3347;border-radius:12px;padding:18px 18px 16px;font-family:inherit;box-shadow:0 18px 50px rgba(0,0,0,.5)}
  .sgc-box h2{margin:0 0 4px;font-size:17px;font-weight:800}
  .sgc-quote{margin:0 0 14px;font-size:12.5px;color:#94a3b8;font-style:italic}
  .sgc-box label{display:block;font-size:11px;font-weight:700;color:#94a3b8;margin:10px 0 4px;letter-spacing:.03em;text-transform:uppercase}
  .sgc-box input,.sgc-box textarea{width:100%;box-sizing:border-box;background:#0f1117;border:1px solid #2e3347;border-radius:7px;color:#e2e8f0;font-size:14px;padding:9px 10px;font-family:inherit}
  .sgc-box input:focus,.sgc-box textarea:focus{outline:none;border-color:#f59e0b}
  .sgc-box input[readonly]{color:#94a3b8}
  .sgc-box textarea{min-height:120px;resize:vertical}
  .sgc-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  .sgc-send{background:#f59e0b;border:none;color:#111;font-weight:800;border-radius:7px;padding:9px 18px;cursor:pointer;font-family:inherit;font-size:13px}
  .sgc-send:disabled{opacity:.5;cursor:default}
  .sgc-cancel{background:none;border:1px solid #2e3347;color:#94a3b8;font-weight:700;border-radius:7px;padding:9px 14px;cursor:pointer;font-family:inherit;font-size:13px}
  .sgc-msg{font-size:12px;margin-top:10px;min-height:16px}
  .sgc-msg.ok{color:#22c55e}.sgc-msg.err{color:#f87171}
  [data-theme="light"] .sgc-box{background:#fff;color:#1a2b3c;border-color:#b8ccd8}
  [data-theme="light"] .sgc-box input,[data-theme="light"] .sgc-box textarea{background:#f0f4f8;color:#1a2b3c;border-color:#b8ccd8}
  [data-theme="light"] .sgc-float{background:rgba(255,255,255,.9)}
  @media (max-width:600px){.sgc-float{top:auto;bottom:14px;right:14px}}
  `;

  function build() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sgc-btn'; btn.textContent = 'Suggest a change';
    btn.title = 'Spotted a bug or want something done differently? Tell us here.';
    const slot = document.querySelector('.hdr-r');
    if (slot) slot.insertBefore(btn, slot.firstChild);
    else { btn.classList.add('sgc-float'); document.body.appendChild(btn); }

    const back = document.createElement('div');
    back.className = 'sgc-back';
    back.innerHTML = `
      <div class="sgc-box" role="dialog" aria-modal="true" aria-labelledby="sgc-title">
        <h2 id="sgc-title">Suggest a change</h2>
        <p class="sgc-quote">"What would you like to see change on this app?" Spotted a bug, or something that should work differently? Tell us here.</p>
        <label for="sgc-from">From</label>
        <input id="sgc-from" readonly>
        <label for="sgc-subject">Subject</label>
        <input id="sgc-subject" maxlength="120" placeholder="e.g. Staff tab won't save Friday's hours">
        <label for="sgc-body">What would you like changed?</label>
        <textarea id="sgc-body" maxlength="4000" placeholder="What happened, what you expected, and where on the app."></textarea>
        <div class="sgc-msg" id="sgc-msg" role="status"></div>
        <div class="sgc-actions">
          <button type="button" class="sgc-cancel" id="sgc-cancel">Cancel</button>
          <button type="button" class="sgc-send" id="sgc-send">Send</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const $ = id => back.querySelector('#' + id);
    const msg = (t, cls) => { const m = $('sgc-msg'); m.textContent = t; m.className = 'sgc-msg' + (cls ? ' ' + cls : ''); };
    const close = () => { back.classList.remove('open'); btn.focus(); };

    btn.addEventListener('click', () => {
      const s = session();
      $('sgc-from').value = (s && s.email) || 'Not signed in';
      msg('');
      $('sgc-send').disabled = false;
      $('sgc-send').style.display = '';
      $('sgc-cancel').textContent = 'Cancel';
      back.classList.add('open');
      setTimeout(() => $('sgc-subject').focus(), 30);
    });
    $('sgc-cancel').addEventListener('click', close);
    back.addEventListener('click', e => { if (e.target === back) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && back.classList.contains('open')) close(); });

    $('sgc-send').addEventListener('click', async () => {
      const subject = $('sgc-subject').value.trim();
      const body = $('sgc-body').value.trim();
      if (!subject) { msg('Add a subject so it has a title.', 'err'); $('sgc-subject').focus(); return; }
      if (!body) { msg('Say what you would like changed.', 'err'); $('sgc-body').focus(); return; }
      const s = await freshSession();
      if (!s) { msg('You need to be signed in to send this. Sign in, then try again.', 'err'); return; }
      $('sgc-send').disabled = true; msg('Sending...');
      try {
        const r = await fetch(FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + s.access_token },
          body: JSON.stringify({ subject, message: body, page: pageName(), url: location.href,
                                 version: (typeof VERSION === 'string' ? VERSION : '') }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
        msg('Sent', 'ok');
        $('sgc-subject').value = ''; $('sgc-body').value = '';
        $('sgc-send').style.display = 'none';
        $('sgc-cancel').textContent = 'Close';
        $('sgc-cancel').focus();
      } catch (e) {
        $('sgc-send').disabled = false;
        msg("Couldn't send just now (" + e.message + '). Your text is still here, so try again in a minute.', 'err');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();

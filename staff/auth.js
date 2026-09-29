// Shared login/session helper for pages that need a real logged-in user
// (not just the public anon key) — Add Staff and Fuel Usage. Session is
// stored in localStorage, which is shared across every page on this origin
// (planner/, staff/ — all github.io/dgc-ballasalla/*), so logging in once
// on any of them keeps you logged in on the others too, until the refresh
// token itself expires (weeks), not just the short-lived access token.

const AUTH_SESSION_KEY = 'dgc_auth_session';

function authHeaders(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

function getStoredSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY)); } catch (e) { return null; }
}
function storeSession(s) {
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(s));
}
function clearSession() {
  localStorage.removeItem(AUTH_SESSION_KEY);
}

// remember = false: sign out automatically 12 hours after signing in
// ("Save password and keep me signed in" switched off on the sign-in page).
const AUTH_FORGET_MS = 12 * 60 * 60 * 1000;
async function login(email, password, remember = true) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ email, password }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.msg || 'Login failed');
  storeSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000, // refresh a minute early
    email: data.user && data.user.email,
    forget_at: remember ? null : Date.now() + AUTH_FORGET_MS,
  });
  return data;
}

// Emails a one-click login link — no password. Comes back to this exact
// page (redirect_to), which then picks the token up out of the URL itself.
async function sendMagicLink(email) {
  const redirectTo = location.href.split('#')[0];
  const r = await fetch(SUPABASE_URL + '/auth/v1/otp', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ email, create_user: false, redirect_to: redirectTo, options: { email_redirect_to: redirectTo } }),
  });
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error_description || data.msg || 'Could not send the link'); }
}

// Clicking the emailed link lands back here with the session in the URL's
// #fragment (never sent to any server, just readable by this page's own JS).
// Pick it up once, save it the same way a password login would, then strip
// it from the address bar so it isn't sitting there or re-usable from history.
function consumeMagicLinkFromUrl() {
  if (!location.hash.includes('access_token=')) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  const expires_in = Number(params.get('expires_in') || 3600);
  if (!access_token || !refresh_token) return false;
  storeSession({ access_token, refresh_token, expires_at: Date.now() + (expires_in - 60) * 1000, email: null });
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

// Several pages share one login (the planner and the Staff, Site Diary and
// Dayworks pages inside it). Only one refreshes at a time (navigator.locks),
// and a page that finds someone else has already refreshed uses that, so two
// pages refreshing at once can't sign everyone out.
async function refreshSession(session) {
  const run = async () => {
    const cur = getStoredSession();
    if (!cur) return null;
    if (cur.refresh_token !== session.refresh_token && Date.now() < cur.expires_at) return cur;
    let r, data;
    try {
      r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ refresh_token: cur.refresh_token }),
      });
      data = await r.json().catch(() => ({}));
    } catch (e) { return null; } // offline: keep the login for later
    if (!r.ok) {
      const now = getStoredSession();
      if (now && now.refresh_token !== cur.refresh_token) return now; // refreshed elsewhere meanwhile
      if (r.status >= 400 && r.status < 500) clearSession();           // really refused
      return null;
    }
    const updated = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
      email: data.user && data.user.email || cur.email,
      forget_at: cur.forget_at || null,
    };
    storeSession(updated);
    return updated;
  };
  if (navigator.locks && navigator.locks.request) return navigator.locks.request('dgc-auth-refresh', run);
  return run();
}

// Returns a valid access token, refreshing silently if needed, or null if
// there's no session / it can't be refreshed (refresh token itself expired
// or was revoked) — caller should show the login form in that case.
async function ensureLoggedIn() {
  consumeMagicLinkFromUrl();
  let session = getStoredSession();
  if (!session) { _askPlannerToSignIn(); return null; }
  if (session.forget_at && Date.now() > session.forget_at) { clearSession(); _askPlannerToSignIn(); return null; }
  if (Date.now() >= session.expires_at) session = await refreshSession(session);
  if (!session) _askPlannerToSignIn();
  return session;
}

// Inside the planner: let the planner show its own sign-in screen instead of
// this page asking for a second login.
function _askPlannerToSignIn() {
  try { if (window.top !== window.self) window.top.postMessage({ type: 'dgc-need-login' }, location.origin); } catch (e) {}
}

function logout() {
  clearSession();
  location.reload();
}

// Headers for a request that should act as the logged-in user (RLS sees
// auth.role() = 'authenticated'), not just the public anon key.
function authedHeaders(session, extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + session.access_token,
    'Content-Type': 'application/json',
  }, extra || {});
}

// Renders a login form into `container` and resolves with the session once
// logged in. Call this when ensureLoggedIn() returns null.
function showLoginForm(container, appName) {
  return new Promise(resolve => {
    container.innerHTML = `
      <div style="max-width:340px;margin:60px auto;padding:24px;background:var(--panel);border:1px solid var(--border);border-radius:12px">
        <h2 style="margin:0 0 4px;font-size:1.1rem">${appName} — Login required</h2>
        <p class="hours-hint" style="margin-bottom:16px">This section holds sensitive records, so it's locked to logged-in accounts only.</p>
        <form id="linkForm" style="display:flex;flex-direction:column;gap:10px">
          <input type="email" id="linkEmail" placeholder="Email" required autocomplete="username">
          <button type="submit" class="primary-btn">Email me a login link</button>
          <p id="linkStatus" class="form-status"></p>
        </form>
        <p class="hours-hint" style="margin:14px 0 6px">Click the link on this device once — after that it stays logged in here, no password, until you log out. A new device just needs its own fresh link.</p>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;color:var(--muted);font-size:0.85rem">Log in with a password instead</summary>
          <form id="loginForm" style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
            <input type="email" id="loginEmail" placeholder="Email" required autocomplete="username">
            <input type="password" id="loginPassword" placeholder="Password" required autocomplete="current-password">
            <button type="submit" class="secondary-btn">Log in</button>
            <p id="loginStatus" class="form-status error"></p>
          </form>
        </details>
      </div>`;

    container.querySelector('#linkForm').addEventListener('submit', async e => {
      e.preventDefault();
      const status = container.querySelector('#linkStatus');
      status.textContent = 'Sending…';
      status.className = 'form-status';
      try {
        await sendMagicLink(container.querySelector('#linkEmail').value);
        status.textContent = 'Check your email and click the link — this page will log in on its own once you do.';
        status.className = 'form-status success';
      } catch (err) {
        status.textContent = err.message;
        status.className = 'form-status error';
      }
    });

    container.querySelector('#loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const status = container.querySelector('#loginStatus');
      status.textContent = 'Logging in…';
      status.className = 'form-status';
      try {
        await login(container.querySelector('#loginEmail').value, container.querySelector('#loginPassword').value);
        resolve(getStoredSession());
      } catch (err) {
        status.textContent = err.message;
        status.className = 'form-status error';
      }
    });
  });
}

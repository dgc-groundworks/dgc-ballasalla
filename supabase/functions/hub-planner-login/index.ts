// hub-planner-login: the Job Planner half of the Silverdale app's "Make a login" (22 Oct 2026).
// Ash, 22 Oct 2026: "she needs an account for the Job Planner, which reverts back to using my OS to sign in, I tried
// clicking, but that didn't do anything. Make an account for the Job Planner."
//
// Supabase Edge Function on the ORIGINAL Job Planner project (vigdtpcgeqenznuakdwz). Additive: it changes nothing in
// os-session-exchange, invite-staff, dgc_os_exchange_check or any table. Database part: supabase/sql/hub-planner-login.sql.
//
// Why it exists: the Planner pages on os.dgc.im swap the OS sign-in for a Planner session (os-session-exchange), and that
// only works when the same email already has a confirmed, not switched off, login on this project. Make a login made only
// the OS login, so new people (Julie McKevitt, 22 Oct 2026) got "not a Job Planner login".
//
// Who may call it: ONLY the hub-make-login Edge Function on the OS project (krslcfmatrskepemgmzn), server to server.
// Two locks, both needed:
//   1. the header x-hub-key must equal this function's secret HUB_PLANNER_KEY (the same secret is set on hub-make-login's
//      project; it is in no page and no git repo). Browsers are refused outright (no CORS, any Origin header refused).
//   2. os_token in the body: the OS sign-in of the director who pressed the button, forwarded by hub-make-login. Checked
//      here as os-session-exchange checks it (signature against the OS project's published keys, issuer, audience, expiry;
//      then the OS project's /auth/v1/user), and then the OS guest list itself says they are a director
//      (silverdale.hub_me() with their own token returns role "director").
// verify_jwt is OFF because the caller has no Planner sign-in: it proves who it is with the two locks above.
//
// Request (POST JSON), one of:
//   { action: "status", os_token, emails: [..] }                  who has a Planner login (login, confirmed, off, allow-listed)
//   { action: "make",   os_token, email, name, password? }        a confirmed Planner login (made, or the one there kept and
//                                                                 switched back on), on the allow-list; the password is set only
//                                                                 if one is given (people normally get in by the OS sign-in)
//   { action: "reset",  os_token, email, password }               the same new password here, only if they have a Planner login
//   { action: "off",    os_token, emails: [..] }                  switched off: banned, every session ended. Nothing deleted.
//   { action: "on",     os_token, emails: [..] }                  switched back on: the ban lifted
// Never returns a token or a password. The OS function logs who did what (silverdale.hub_login_log).

import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HUB_KEY = Deno.env.get("HUB_PLANNER_KEY") ?? "";
const OS_URL = "https://krslcfmatrskepemgmzn.supabase.co";
const OS_PUBLIC_KEY = "sb_publishable_qaGuPqBI5kIou0_Uzivhmw_TC2vffjy"; // public: shipped in every OS page
const OS_ISSUER = OS_URL + "/auth/v1";
const JWKS = createRemoteJWKSet(new URL(OS_ISSUER + "/.well-known/jwks.json"));
const BAN = "876000h"; // about 100 years: switched off until a director switches them back on
const MAX_BYTES = 16384;

class Plain extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length > 0;
}

async function rpc(name: string, args: unknown): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const t = await r.text();
  if (!r.ok) { console.error(`database ${name}: ${r.status} ${t.slice(0, 200)}`); throw new Plain(500, "The Job Planner's database didn't answer properly."); }
  return t ? JSON.parse(t) : null;
}

async function admin(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; j: Record<string, unknown> }> {
  const r = await fetch(`${SB_URL}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j: Record<string, unknown> = {};
  try { j = t ? JSON.parse(t) : {}; } catch { /* not JSON */ }
  if (!r.ok) console.error(`auth admin ${method} ${path.split("/")[0]}: ${r.status} ${String(j.msg ?? j.message ?? j.error ?? "").slice(0, 200)}`);
  return { ok: r.ok, status: r.status, j };
}
const mustAdmin = async (method: string, path: string, body?: unknown) => {
  const a = await admin(method, path, body);
  if (!a.ok) throw new Plain(502, "The Job Planner's sign-in service didn't answer properly.");
  return a.j;
};

type State = { email: string; id: string | null; login: boolean; confirmed: boolean; off: boolean; allow: boolean; lastSignIn: string | null };
const stateOf = async (emails: string[]) => (await rpc("hub_planner_login_state", { p_emails: emails })) as State[];

const cleanEmail = (v: unknown) => {
  const e = String(v ?? "").trim().toLowerCase();
  if (!e || e.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Plain(400, "That email doesn't look right.");
  return e;
};
const cleanEmails = (v: unknown) => {
  if (!Array.isArray(v) || v.length > 300) throw new Plain(400, "No emails sent.");
  return Array.from(new Set(v.map(cleanEmail)));
};
const cleanPassword = (v: unknown) => {
  if (v === undefined || v === null || v === "") return null;
  const p = String(v);
  if (p.length < 10 || new TextEncoder().encode(p).length > 72) throw new Plain(400, "The password needs 10 to 72 characters.");
  return p;
};

// lock 2: the director's own OS sign-in
async function director(tok: string): Promise<string> {
  let claim = "";
  try {
    const { payload } = await jwtVerify(tok, JWKS, { issuer: OS_ISSUER, audience: "authenticated" });
    if (payload.role !== "authenticated" || payload.is_anonymous === true) throw new Error("role");
    claim = String(payload.email ?? "").toLowerCase().trim();
  } catch (_) { throw new Plain(401, "Sign in again."); }
  const u = await fetch(OS_URL + "/auth/v1/user", { headers: { apikey: OS_PUBLIC_KEY, Authorization: "Bearer " + tok } });
  if (!u.ok) throw new Plain(401, "Sign in again.");
  const user = await u.json();
  const email = String(user.email ?? "").toLowerCase().trim();
  if (!email || email !== claim || !user.email_confirmed_at) throw new Plain(401, "Sign in again.");
  const me = await fetch(OS_URL + "/rest/v1/rpc/hub_me", {
    method: "POST",
    headers: { apikey: OS_PUBLIC_KEY, Authorization: "Bearer " + tok, "Content-Type": "application/json", "Content-Profile": "silverdale", "Accept-Profile": "silverdale" },
    body: "{}",
  });
  if (!me.ok) throw new Plain(403, "Only directors can make or change logins.");
  const m = await me.json().catch(() => null) as { role?: string; email?: string } | null;
  if (!m || m.role !== "director" || String(m.email ?? "").toLowerCase() !== email) throw new Plain(403, "Only directors can make or change logins.");
  return email;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false, message: "POST only" });
  if (req.headers.get("origin")) return reply(403, { ok: false, message: "Not for browsers." });
  if (!SB_URL || !SERVICE || HUB_KEY.length < 32) return reply(503, { ok: false, message: "This function isn't set up yet." });
  try {
    if (!sameKey(req.headers.get("x-hub-key") ?? "", HUB_KEY)) throw new Plain(401, "Not allowed.");
    const raw = await req.text();
    if (raw.length > MAX_BYTES) throw new Plain(413, "Too much sent.");
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw || "{}"); } catch { throw new Plain(400, "Nothing was sent."); }
    const by = await director(typeof body.os_token === "string" ? body.os_token.trim() : "");
    const action = String(body.action ?? "");

    if (action === "status") {
      return reply(200, { ok: true, people: await stateOf(cleanEmails(body.emails)) });
    }

    if (action === "make") {
      const email = cleanEmail(body.email);
      const name = String(body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
      let password = cleanPassword(body.password);
      const [st] = await stateOf([email]);
      let made = false, passwordSet = false, passwordRefused = false;
      if (!st.login) {
        let a = await admin("POST", "users", { email, email_confirm: true, ...(password ? { password } : {}), user_metadata: { full_name: name, made_in: "Silverdale app (Make a login)", made_by: by } });
        if (!a.ok && password && a.status === 422 && /password/i.test(String(a.j.msg ?? a.j.message ?? a.j.error_code ?? ""))) {
          passwordRefused = true; password = null; // the login still works through the OS sign-in
          a = await admin("POST", "users", { email, email_confirm: true, user_metadata: { full_name: name, made_in: "Silverdale app (Make a login)", made_by: by } });
        }
        if (!a.ok) throw new Plain(502, "The Job Planner's sign-in service didn't make the login.");
        made = true; passwordSet = !!password;
      } else {
        const a = await admin("PUT", `users/${st.id}`, { email_confirm: true, ban_duration: "none", ...(password ? { password } : {}) });
        if (!a.ok && password && a.status === 422) {
          passwordRefused = true;
          await mustAdmin("PUT", `users/${st.id}`, { email_confirm: true, ban_duration: "none" });
        } else if (!a.ok) throw new Plain(502, "The Job Planner's sign-in service didn't answer properly.");
        else passwordSet = !!password;
      }
      const allowAdded = await rpc("hub_planner_allow", { p_email: email }) as boolean;
      const [now] = await stateOf([email]);
      return reply(200, { ok: true, email, made, passwordSet, passwordRefused, allowAdded, planner: now });
    }

    if (action === "reset") {
      const email = cleanEmail(body.email);
      const password = cleanPassword(body.password);
      if (!password) throw new Plain(400, "No password sent.");
      const [st] = await stateOf([email]);
      if (!st.login) return reply(200, { ok: true, email, login: false, passwordSet: false });
      const a = await admin("PUT", `users/${st.id}`, { password });
      return reply(200, { ok: true, email, login: true, passwordSet: a.ok, passwordRefused: !a.ok });
    }

    if (action === "off" || action === "on") {
      const on = action === "on";
      const done: Array<Record<string, unknown>> = [];
      for (const st of await stateOf(cleanEmails(body.emails))) {
        if (!st.login || !st.id) { done.push({ email: st.email, login: false }); continue; }
        await mustAdmin("PUT", `users/${st.id}`, { ban_duration: on ? "none" : BAN });
        const ended = on ? 0 : await rpc("hub_planner_end_sessions", { p_user: st.id }) as number;
        done.push({ email: st.email, login: true, off: !on, sessionsEnded: ended });
      }
      return reply(200, { ok: true, done });
    }

    throw new Plain(400, "Unknown action.");
  } catch (e) {
    if (e instanceof Plain) return reply(e.status, { ok: false, message: e.message });
    console.error("hub-planner-login", String(e).slice(0, 200));
    return reply(500, { ok: false, message: "Something went wrong on the Job Planner side." });
  }
});

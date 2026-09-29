// invite-staff — Job Planner (vigdtpcgeqenznuakdwz), 29 Sep 2026.
//
// Called from staff/invite.html by a signed-in admin. Adds the email to the
// dgc_app_admins allowlist and returns a join link for Ash to send himself.
// Nothing is emailed by this function.
//
// Why the link points at our own join page instead of Supabase's verify URL:
// Supabase's own links are one-time and are "used up" the moment anything
// opens them. Outlook / M365 link scanners open links in emails and texts
// before the person does, which is what broke earlier invite links. The join
// page only spends the token when the person presses "Accept", which a
// scanner never does.
//
// Deploy: Supabase dashboard > Edge Functions > Deploy a new function >
// name it exactly  invite-staff  > paste this file > Deploy.
// Leave "Verify JWT" ON. No secrets to add — the service key is built in.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PLANNER_JOIN_URL = 'https://dgc-groundworks.github.io/dgc-ballasalla/planner/join.html'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const key =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
    Deno.env.get('SUPABASE_SECRET_KEY') ||
    Deno.env.get('SB_SECRET_KEY')
  if (!url || !key) return json({ error: 'Missing Supabase credentials in the function environment' }, 500)
  const admin = createClient(url, key, { auth: { persistSession: false } })

  // 1. Caller must be a signed-in admin on the allowlist
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const { data: caller, error: callerErr } = await admin.auth.getUser(token)
  if (callerErr || !caller?.user?.email) return json({ error: 'Not signed in' }, 401)
  const { data: callerRow } = await admin
    .from('dgc_app_admins').select('email').eq('email', caller.user.email.toLowerCase()).maybeSingle()
  if (!callerRow) return json({ error: 'Only Job Planner admins can send invites' }, 403)

  // 2. Who to invite
  let body: { email?: string; name?: string }
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  const email = (body.email || '').trim().toLowerCase()
  const name = (body.name || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'That email doesn\'t look right' }, 400)

  // 3. Allowlist them (so they see everything once they're in)
  const { error: allowErr } = await admin.from('dgc_app_admins').upsert({ email }, { onConflict: 'email' })
  if (allowErr) return json({ error: 'Could not add to allowlist: ' + allowErr.message }, 500)

  // 4. Invite link for a new person, sign-in link for someone who already has an account
  let type: 'invite' | 'magiclink' = 'invite'
  let { data, error } = await admin.auth.admin.generateLink({
    type: 'invite', email, options: { data: name ? { full_name: name } : undefined },
  })
  if (error && /already|registered|exists/i.test(error.message)) {
    type = 'magiclink'
    ;({ data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email }))
  }
  if (error || !data?.properties?.hashed_token) return json({ error: 'Could not create the link: ' + (error?.message || 'no token') }, 500)

  const joinUrl = PLANNER_JOIN_URL + '#th=' + encodeURIComponent(data.properties.hashed_token) +
    '&t=' + type + '&e=' + encodeURIComponent(email)

  return json({ ok: true, email, type, join_url: joinUrl })
})

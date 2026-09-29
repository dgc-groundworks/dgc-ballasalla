# Suggest a change: deploy reference

A "Suggest a change" button sits in the planner header (and in the top corner of every staff, site diary and dayworks page when opened on its own). It opens a pop-up with **From** (the signed-in user), **Subject** and **Message**. Pressing **Send** creates a Trello card in the **AHP board, INBOX list** (`6a4705b2bd876f10e03a771f`):
- **Title:** `App change: <subject>`
- **Description:** the message, then who sent it, the page, the app version and the time

Front end: `planner/suggest-change.js`, loaded with `<script src="../planner/suggest-change.js"></script>`.

The Trello key and token must **never** go in the page, because it is public on GitHub Pages. They live only in the Edge Function's secrets.

## 1. Edge Function `suggest-change` (Supabase project vigdtpcgeqenznuakdwz)

Supabase dashboard › Edge Functions › Deploy a new function › name `suggest-change` › paste this code. Leave "Verify JWT" **on**.

```ts
// suggest-change: turns an app suggestion into a Trello card (AHP board INBOX).
// Caller must be a signed-in DGC user; the From line is taken from their verified login.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request" }, 400); }
  const subject = String(body.subject ?? "").trim().slice(0, 120);
  const message = String(body.message ?? "").trim().slice(0, 4000);
  if (!subject || !message) return json({ ok: false, error: "Subject and message are required" }, 400);
  const page = String(body.page ?? "").slice(0, 200);
  const url = String(body.url ?? "").slice(0, 300);
  const version = String(body.version ?? "").slice(0, 30);

  const key = Deno.env.get("TRELLO_KEY");
  const token = Deno.env.get("TRELLO_TOKEN");
  const list = Deno.env.get("TRELLO_LIST_ID") ?? "6a4705b2bd876f10e03a771f"; // AHP board, INBOX
  if (!key || !token) return json({ ok: false, error: "Trello not configured" }, 500);

  const sent = new Date().toLocaleString("en-GB", { timeZone: "Europe/Isle_of_Man" });
  const desc = `${message}\n\n---\n**From:** ${user.email}\n**Page:** ${page}\n**Link:** ${url}\n**App version:** ${version}\n**Sent:** ${sent}`;

  const r = await fetch(`https://api.trello.com/1/cards?idList=${list}&key=${key}&token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `App change: ${subject}`, desc, pos: "top" }),
  });
  if (!r.ok) return json({ ok: false, error: `Trello said ${r.status}` }, 502);
  const card = await r.json();
  return json({ ok: true, url: card.shortUrl });
});
```

## 2. Secrets (Ash sets these; Claude doesn't type tokens)

Supabase dashboard › Edge Functions › Secrets › add:
- `TRELLO_KEY`: the Trello API key
- `TRELLO_TOKEN`: the Trello token

Both are in Obsidian: `Tech & Apps/Integrations & API Keys.md`.
- `TRELLO_LIST_ID` is optional; it defaults to the AHP INBOX list.

## 3. Test
Open the planner, click **Suggest a change**, and send a test. The card should appear at the top of the AHP INBOX list.

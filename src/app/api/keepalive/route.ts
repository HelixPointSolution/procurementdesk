/* GET /api/keepalive — stops the free Supabase project from pausing.
 *
 * Supabase pauses free-tier projects after 7 days without activity; on
 * 9 Oct 2026 that took the whole desk offline. Vercel Cron (vercel.json)
 * calls this once a day and it runs one real database query.
 *
 * This is the free workaround. It is not guaranteed by Supabase — the
 * dependable fix is the Pro plan, on which projects are never paused.
 *
 * When CRON_SECRET is set in Vercel, only Vercel Cron (which sends it as a
 * bearer token) can trigger the query.
 */

import { createClient } from "@supabase/supabase-js";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
  // A real SELECT reaches Postgres even though RLS returns no rows to the
  // anonymous role — that database traffic is what counts as activity.
  const { error } = await sb.from("suppliers").select("id", { head: true, count: "exact" });
  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 502 });
  }
  return Response.json({ ok: true, at: new Date().toISOString() });
}

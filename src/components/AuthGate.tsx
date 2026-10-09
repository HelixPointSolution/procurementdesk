"use client";

/* Everything in the app renders behind this gate. RLS is the real security
 * boundary (anon role sees nothing); this provides the sign-in UX.
 * Public sign-ups are disabled — team accounts are created in the Supabase
 * dashboard (Authentication → Users → Add user).
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sb = supabase();
    let alive = true;

    // When the database is unreachable (on 9 Oct 2026 Supabase paused the free
    // project and removed its address), refreshing a saved login retries
    // forever and the page sat on "Loading…" with no explanation. Check
    // reachability in parallel and say what is wrong instead.
    (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
          headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        if (alive) { setOffline(true); setLoading(false); }
      }
    })();

    sb.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  }

  if (offline) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-xl shadow p-8 w-full max-w-md space-y-3" role="alert">
          <h1 className="text-xl font-bold">🏭 Helix Point — Procurement Desk</h1>
          <p className="font-semibold text-red-700">Can&apos;t reach the database right now.</p>
          <p className="text-sm text-gray-600">
            Your data is safe. The most likely cause is that the free Supabase project was paused
            after a week without use. An administrator can restore it at
            supabase.com/dashboard → Procurement Desk → <b>Restore project</b>. It takes a few minutes.
          </p>
          <button onClick={() => window.location.reload()} className="btn-primary">Try again</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="p-10 text-center text-gray-500">Loading…</div>;
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <form onSubmit={signIn} className="bg-white rounded-xl shadow p-8 w-full max-w-sm space-y-4">
          <h1 className="text-xl font-bold">🏭 Helix Point — Procurement Desk</h1>
          <p className="text-sm text-gray-500">
            Team sign-in. Accounts are created by the administrator.
          </p>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <button
            type="submit" disabled={busy}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 font-medium disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}

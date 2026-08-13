"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

/* Tab order mirrors the client's spec workbook. */
const TABS = [
  { href: "/rfq/material", label: "1 · RFQ Material" },
  { href: "/rfq/general", label: "2 · RFQ General" },
  { href: "/compare/material", label: "3 · Compare (Material)" },
  { href: "/compare/general", label: "4 · Compare (General)" },
  { href: "/scorecard", label: "5 · Scorecard" },
  { href: "/suppliers", label: "6 · Supplier List" },
  { href: "/history", label: "7 · Purchase History" },
];

export default function Nav() {
  const pathname = usePathname();
  const [email, setEmail] = useState("");

  useEffect(() => {
    supabase().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  return (
    <header className="app-header">
      <div className="max-w-5xl mx-auto px-4">
        <div className="flex items-center justify-between py-4 gap-3 flex-wrap">
          <div>
            <h1 className="font-extrabold text-xl">🏭 Helix Point — Procurement Desk</h1>
            <p className="text-sm opacity-90">
              RFQ · Quote Comparison · Supplier Scorecard — shared with your team.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="opacity-90">{email}</span>
            <button
              onClick={() => supabase().auth.signOut()}
              className="border border-white/40 hover:bg-white/15 rounded-lg px-3 py-1.5"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
      <nav aria-label="Sections" className="max-w-5xl mx-auto px-4">
        <div className="flex gap-1.5 overflow-x-auto">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`tab-link ${active ? "is-active" : ""}`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}

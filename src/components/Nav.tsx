"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

/* Tab order mirrors the client's Excel tab bar. */
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
    <header className="bg-white border-b sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between py-3">
          <h1 className="font-bold text-lg">🏭 Helix Point — Procurement Desk</h1>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-500">{email}</span>
            <button
              onClick={() => supabase().auth.signOut()}
              className="text-gray-600 hover:text-black border rounded-lg px-3 py-1"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-2">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
                  active ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

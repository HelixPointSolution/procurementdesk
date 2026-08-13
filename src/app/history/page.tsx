"use client";

/* Tab 7 — Purchase History.
 * Auto-filled by the Award button on the comparison tabs (always the
 * purchaser's choice; notes come from the comparison). Every cell stays
 * editable afterwards — Excel comment: "purchaser also can manually modify
 * the auto filled info". Rows can also be added by hand.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { PurchaseHistoryRow } from "@/lib/types";

export default function HistoryPage() {
  const [rows, setRows] = useState<PurchaseHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const { data } = await supabase()
      .from("purchase_history").select("*")
      .order("date", { ascending: false });
    setRows((data as PurchaseHistoryRow[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function update(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase().from("purchase_history").update(patch).eq("id", id);
    if (error) alert(error.message);
    await load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this history row?")) return;
    await supabase().from("purchase_history").delete().eq("id", id);
    await load();
  }

  async function addBlank() {
    const { data: userData } = await supabase().auth.getUser();
    const { error } = await supabase().from("purchase_history").insert({
      created_by: userData.user?.email ?? "",
    });
    if (error) alert(error.message);
    await load();
  }

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">Purchase History</h2>
          <p className="text-sm text-gray-500">Auto-filled on award (purchaser&apos;s choice). Click any cell to edit.</p>
        </div>
        <button onClick={addBlank} className="border rounded-lg px-3 py-1.5 text-sm hover:bg-gray-100">
          + Add row manually
        </button>
      </div>
      <div className="tbl-wrap overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2 w-32">Date</th>
              <th className="px-3 py-2">Ref</th>
              <th className="px-3 py-2">Award to</th>
              <th className="px-3 py-2 w-28">Total RM</th>
              <th className="px-3 py-2">Notes</th>
              <th className="px-3 py-2">By</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1">
                  <input type="date" defaultValue={r.date} className="border-0 bg-transparent focus:bg-white focus:border rounded px-1 py-0.5"
                    onBlur={(e) => e.target.value !== r.date && update(r.id, { date: e.target.value })} />
                </td>
                <Cell value={r.ref} onSave={(v) => update(r.id, { ref: v })} />
                <Cell value={r.awarded_to} onSave={(v) => update(r.id, { awarded_to: v })} />
                <Cell value={r.total_rm == null ? "" : String(r.total_rm)}
                  onSave={(v) => update(r.id, { total_rm: v.trim() === "" ? null : Number(v) })} />
                <Cell value={r.notes} onSave={(v) => update(r.id, { notes: v })} />
                <td className="px-3 py-1 text-gray-400 text-xs">{r.created_by}</td>
                <td className="px-3 py-1">
                  <button
                    onClick={() => remove(r.id)}
                    aria-label={`Delete purchase record ${r.ref || r.awarded_to}`}
                    title="Delete row"
                    className="text-red-400 hover:text-red-600 px-2 py-1.5"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No purchases recorded yet — award a quote in the Comparison tab.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  return (
    <td className="px-3 py-1">
      <input
        defaultValue={value}
        className="w-full border-0 bg-transparent focus:bg-white focus:border rounded px-1 py-0.5"
        onBlur={(e) => e.target.value !== value && onSave(e.target.value)}
      />
    </td>
  );
}

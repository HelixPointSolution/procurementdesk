"use client";

/* Tab 5 — Supplier Scorecard (ported from the v1 tool).
 * Weighted 1–5 ratings per supplier, shared with the team via the
 * scorecards table.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ScorecardRow, SupplierRow } from "@/lib/types";

const CRIT: Array<[string, number]> = [
  ["Price (RM/kg)", 3],
  ["Spec accuracy", 3],
  ["Response speed", 2],
  ["Stock / lead time", 2],
  ["Payment terms", 1],
];
const MAX = CRIT.reduce((a, c) => a + c[1] * 5, 0);

interface Draft {
  supplierName: string;
  scores: number[];
  note: string;
}

export default function ScorecardPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ranked, setRanked] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const sb = supabase();
    Promise.all([
      sb.from("scorecards").select("*").order("supplier_name"),
      sb.from("suppliers").select("*").order("name"),
    ]).then(([sc, sup]) => {
      setDrafts(
        ((sc.data as ScorecardRow[]) ?? []).map((r) => ({
          supplierName: r.supplier_name,
          scores: [...r.scores],
          note: r.note,
        }))
      );
      setSuppliers((sup.data as SupplierRow[]) ?? []);
      setLoading(false);
    });
  }, []);

  function setDraft(i: number, patch: Partial<Draft>) {
    setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  async function save() {
    const { data: userData } = await supabase().auth.getUser();
    const rows = drafts
      .filter((d) => d.supplierName.trim())
      .map((d) => ({
        supplier_name: d.supplierName.trim(),
        scores: d.scores,
        note: d.note,
        updated_by: userData.user?.email ?? "",
        updated_at: new Date().toISOString(),
      }));
    const { error } = await supabase()
      .from("scorecards")
      .upsert(rows, { onConflict: "supplier_name" });
    setMsg(error ? "Error: " + error.message : "Saved to team ✓");
  }

  async function removeDraft(i: number) {
    const d = drafts[i];
    if (d.supplierName.trim() && !confirm(`Remove scorecard for "${d.supplierName}"?`)) return;
    await supabase().from("scorecards").delete().eq("supplier_name", d.supplierName.trim());
    setDrafts(drafts.filter((_, j) => j !== i));
  }

  const total = (d: Draft) => CRIT.reduce((a, c, i) => a + c[1] * (d.scores[i] || 0), 0);
  const rankedRows = drafts
    .filter((d) => d.supplierName.trim())
    .map((d) => ({ ...d, tot: total(d) }))
    .sort((a, b) => b.tot - a.tot);

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Supplier Scorecard</h2>
        <p className="text-sm text-gray-500">Score 1–5 per criterion (weights in ×N). Shared with the whole team.</p>
      </div>

      {drafts.map((d, i) => (
        <div key={i} className="bg-white border rounded-lg p-3">
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-56">
              <label className="block text-xs text-gray-500">Supplier</label>
              <input
                value={d.supplierName}
                onChange={(e) => setDraft(i, { supplierName: e.target.value })}
                list="supplier-names-score"
                className="w-full border rounded-lg px-2 py-1.5 text-sm font-medium"
              />
            </div>
            {CRIT.map((c, ci) => (
              <div key={c[0]} className="w-28">
                <label className="block text-xs text-gray-500">{c[0]} ×{c[1]}</label>
                <input
                  type="number" min={1} max={5}
                  value={d.scores[ci] ?? 3}
                  onChange={(e) => {
                    const s = [...d.scores];
                    s[ci] = Math.max(1, Math.min(5, Number(e.target.value) || 1));
                    setDraft(i, { scores: s });
                  }}
                  className="w-full border rounded-lg px-2 py-1.5 text-sm"
                />
              </div>
            ))}
            <div className="pb-1.5 text-sm font-bold w-20">{total(d)} / {MAX}</div>
            <button onClick={() => removeDraft(i)} className="text-red-400 hover:text-red-600 pb-1.5">✕</button>
          </div>
          <div className="mt-2">
            <input
              value={d.note}
              onChange={(e) => setDraft(i, { note: e.target.value })}
              placeholder="Notes — e.g. reliability, terms, quality history"
              className="w-full border rounded-lg px-2 py-1.5 text-sm"
            />
          </div>
        </div>
      ))}
      <datalist id="supplier-names-score">
        {suppliers.map((s) => <option key={s.id} value={s.name} />)}
      </datalist>

      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setDrafts([...drafts, { supplierName: "", scores: [3, 3, 3, 3, 3], note: "" }])}
          className="border rounded-lg px-3 py-1.5 text-sm hover:bg-gray-100"
        >
          + Add supplier
        </button>
        <button onClick={() => setRanked(true)} className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium">
          🏆 Rank suppliers
        </button>
        <button onClick={save} className="bg-gray-900 text-white rounded-lg px-4 py-2 text-sm font-medium">
          ☁️ Save to team
        </button>
        {msg && <span className="text-sm text-green-700">{msg}</span>}
      </div>

      {ranked && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 text-left">
              <tr>
                <th className="px-3 py-2 w-16">Rank</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Weighted score</th>
                <th className="px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rankedRows.map((r, i) => (
                <tr key={r.supplierName} className={i === 0 ? "bg-green-50" : ""}>
                  <td className="px-3 py-2">{i === 0 ? "🏆 1" : i + 1}</td>
                  <td className="px-3 py-2 font-medium">{r.supplierName}</td>
                  <td className="px-3 py-2"><b>{r.tot}</b> / {MAX}</td>
                  <td className="px-3 py-2 text-gray-500">{r.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

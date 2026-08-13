"use client";

/* Tab 5 — Supplier Scorecard. Weighted 1–5 ratings per supplier, team-shared.
 *
 * Rows are keyed on the server id, not the (editable) supplier name — keying
 * on the name meant renaming a supplier then deleting removed nothing, and
 * saving after a rename created a duplicate row instead of renaming.
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
const DEFAULT_SCORES = [3, 3, 3, 3, 3];

/** Pad/truncate to exactly one score per criterion — a short array used to
 *  display as 3 but contribute 0 to the weighted total. */
function normaliseScores(scores: number[] | null | undefined): number[] {
  const out = [...DEFAULT_SCORES];
  (scores ?? []).slice(0, CRIT.length).forEach((v, i) => {
    if (Number.isFinite(v)) out[i] = Math.max(1, Math.min(5, Math.round(v)));
  });
  return out;
}

interface Draft {
  id?: string;
  supplierName: string;
  scores: number[];
  note: string;
}

export default function ScorecardPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const sb = supabase();
    const [sc, sup] = await Promise.all([
      sb.from("scorecards").select("*").order("supplier_name"),
      sb.from("suppliers").select("*").order("name"),
    ]);
    if (sc.error) setError(sc.error.message);
    else {
      setDrafts(((sc.data as ScorecardRow[]) ?? []).map((r) => ({
        id: r.id,
        supplierName: r.supplier_name,
        scores: normaliseScores(r.scores),
        note: r.note,
      })));
      setError("");
    }
    if (!sup.error) setSuppliers((sup.data as SupplierRow[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function setDraft(i: number, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  async function save() {
    setBusy(true);
    setMsg("");
    const sb = supabase();
    const { data: userData } = await sb.auth.getUser();
    const who = userData.user?.email ?? "";
    const named = drafts.filter((d) => d.supplierName.trim());

    for (const d of named) {
      const payload = {
        supplier_name: d.supplierName.trim(),
        scores: normaliseScores(d.scores),
        note: d.note,
        updated_by: who,
        updated_at: new Date().toISOString(),
      };
      const res = d.id
        ? await sb.from("scorecards").update(payload).eq("id", d.id)
        : await sb.from("scorecards").insert(payload);
      if (res.error) {
        setError(res.error.message);
        setBusy(false);
        return;
      }
    }
    setError("");
    setMsg("Saved to team ✓");
    setBusy(false);
    load();
  }

  async function removeDraft(i: number) {
    const d = drafts[i];
    if (d.id && !confirm(`Remove scorecard for "${d.supplierName}"?`)) return;
    if (d.id) {
      const { error } = await supabase().from("scorecards").delete().eq("id", d.id);
      if (error) { setError(error.message); return; }
    }
    setDrafts((prev) => prev.filter((_, j) => j !== i));
  }

  const total = (d: Draft) =>
    CRIT.reduce((a, c, i) => a + c[1] * (normaliseScores(d.scores)[i] ?? 0), 0);
  const ranked = drafts
    .filter((d) => d.supplierName.trim())
    .map((d) => ({ ...d, tot: total(d) }))
    .sort((a, b) => b.tot - a.tot);

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Supplier Scorecard</h2>
        <p className="hint">Score 1–5 per criterion (weights ×N). Shared with the whole team.</p>
      </div>
      {error && <div className="flag" role="alert">{error}</div>}

      {drafts.map((d, i) => (
        <div key={d.id ?? `new-${i}`} className="card">
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-52">
              <label htmlFor={`sc-name-${i}`} className="lbl">Supplier</label>
              <input
                id={`sc-name-${i}`}
                value={d.supplierName}
                onChange={(e) => setDraft(i, { supplierName: e.target.value })}
                list="supplier-names-score"
                className="w-full fld text-sm font-medium"
              />
            </div>
            {CRIT.map((c, ci) => (
              <div key={c[0]} className="w-28">
                <label htmlFor={`sc-${i}-${ci}`} className="lbl">{c[0]} ×{c[1]}</label>
                <input
                  id={`sc-${i}-${ci}`}
                  type="number" min={1} max={5}
                  value={normaliseScores(d.scores)[ci]}
                  onChange={(e) => {
                    const s = normaliseScores(d.scores);
                    s[ci] = Math.max(1, Math.min(5, Number(e.target.value) || 1));
                    setDraft(i, { scores: s });
                  }}
                  className="w-full fld text-sm"
                />
              </div>
            ))}
            <div className="pb-2 text-sm font-bold w-20">{total(d)} / {MAX}</div>
            <button
              onClick={() => removeDraft(i)}
              aria-label={`Remove scorecard for ${d.supplierName || "supplier"}`}
              className="text-red-400 hover:text-red-600 px-2 py-2"
            >
              ✕
            </button>
          </div>
          <div className="mt-2">
            <label htmlFor={`sc-note-${i}`} className="lbl">Notes</label>
            <input
              id={`sc-note-${i}`}
              value={d.note}
              onChange={(e) => setDraft(i, { note: e.target.value })}
              placeholder="e.g. reliability, terms, quality history"
              className="w-full fld text-sm"
            />
          </div>
        </div>
      ))}
      <datalist id="supplier-names-score">
        {suppliers.map((s) => <option key={s.id} value={s.name} />)}
      </datalist>

      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setDrafts((prev) => [...prev, { supplierName: "", scores: [...DEFAULT_SCORES], note: "" }])}
          className="btn-ghost text-sm"
        >
          + Add supplier
        </button>
        <button onClick={save} disabled={busy} className="btn-primary disabled:opacity-50">
          {busy ? "Saving…" : "☁️ Save to team"}
        </button>
        {msg && <span className="text-sm text-green-700">{msg}</span>}
      </div>

      {ranked.length > 0 && (
        <div>
          <div className="chart-title">Ranking</div>
          <div className="overflow-x-auto tbl-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="w-16">Rank</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Weighted score</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => (
                  <tr key={r.id ?? r.supplierName} className={i === 0 ? "win-row" : ""}>
                    <td>{i === 0 ? "🏆 1" : i + 1}</td>
                    <td className="font-medium">{r.supplierName}</td>
                    <td><b>{r.tot}</b> / {MAX}</td>
                    <td className="text-gray-600">{r.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

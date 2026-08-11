"use client";

/* Tabs 3 & 4 — Quote Comparison (Material / General).
 *
 * Reality the Excel spec demands:
 *   - suppliers may quote different dims than asked (off-spec, flagged not hidden)
 *   - suppliers may skip items ("No stock for item 2") — untick "Quoted"
 *   - per-item notes and per-supplier notes
 *   - the tool recommends ("Claude's Choice") but the purchaser decides
 *     ("always follow purchaser's choice"), and Award writes Purchase History.
 */

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { RfqKind, RfqRow, RfqItemRow, QuoteRow, QuoteItemRow, SupplierRow } from "@/lib/types";
import { analyseQuotes, type ComparisonResult } from "@/lib/compare";

interface QuoteItemDraft {
  quoted: boolean;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: string;
  price: string;
  notes: string;
}

interface QuoteDraft {
  supplierName: string;
  notes: string;
  items: QuoteItemDraft[]; // parallel to rfq items
}

function toNumber(s: string): number | null {
  const n = Number(s);
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
}

const rm = (n: number) => "RM " + n.toFixed(2);

export default function CompareEditor({ kind }: { kind: RfqKind }) {
  const isMaterial = kind === "material";
  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [rfqId, setRfqId] = useState("");
  const [items, setItems] = useState<RfqItemRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteDraft[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [analysed, setAnalysed] = useState(false);
  const [choice, setChoice] = useState(""); // Purchaser's Choice (supplier name)
  const [awardMsg, setAwardMsg] = useState("");

  useEffect(() => {
    const sb = supabase();
    sb.from("rfqs").select("*").eq("kind", kind)
      .order("created_at", { ascending: false }).limit(100)
      .then(({ data }) => setRfqs((data as RfqRow[]) ?? []));
    sb.from("suppliers").select("*").order("name")
      .then(({ data }) => setSuppliers((data as SupplierRow[]) ?? []));
  }, [kind]);

  async function loadRfq(id: string) {
    setRfqId(id);
    setAnalysed(false);
    setAwardMsg("");
    setChoice("");
    if (!id) { setItems([]); setQuotes([]); return; }
    const sb = supabase();
    const [{ data: its }, { data: qs }] = await Promise.all([
      sb.from("rfq_items").select("*").eq("rfq_id", id).order("position"),
      sb.from("quotes").select("*, quote_items(*)").eq("rfq_id", id).order("created_at"),
    ]);
    const rfqItems = (its as RfqItemRow[]) ?? [];
    setItems(rfqItems);
    type QuoteWithItems = QuoteRow & { quote_items: QuoteItemRow[] };
    setQuotes(
      (((qs ?? []) as QuoteWithItems[])).map((q) => ({
        supplierName: q.supplier_name,
        notes: q.notes,
        items: rfqItems.map((it) => {
          const qi = q.quote_items.find((x) => x.rfq_item_id === it.id);
          return qi
            ? {
                quoted: true,
                thicknessRaw: qi.thickness_raw ?? "",
                heightRaw: qi.height_raw ?? "",
                lengthRaw: qi.length_raw ?? "",
                qty: qi.qty == null ? "" : String(qi.qty),
                price: qi.price == null ? "" : String(qi.price),
                notes: qi.notes,
              }
            : blankQuoteItem(it, false);
        }),
      }))
    );
  }

  function blankQuoteItem(it: RfqItemRow, quoted: boolean): QuoteItemDraft {
    return {
      quoted,
      // prefill with the inquiry dims — supplier usually quotes what was asked
      thicknessRaw: it.thickness_raw ?? "",
      heightRaw: it.height_raw ?? "",
      lengthRaw: it.length_raw ?? "",
      qty: it.qty == null ? "" : String(it.qty),
      price: "",
      notes: "",
    };
  }

  function addQuote() {
    setQuotes([
      ...quotes,
      { supplierName: "", notes: "", items: items.map((it) => blankQuoteItem(it, true)) },
    ]);
  }

  function setQuote(i: number, patch: Partial<QuoteDraft>) {
    setQuotes(quotes.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  }
  function setQuoteItem(i: number, k: number, patch: Partial<QuoteItemDraft>) {
    setQuotes(
      quotes.map((q, j) =>
        j === i
          ? { ...q, items: q.items.map((qi, l) => (l === k ? { ...qi, ...patch } : qi)) }
          : q
      )
    );
  }

  async function saveQuotes() {
    if (!rfqId) return;
    setBusy(true);
    const sb = supabase();
    // simplest reliable sync: replace all quotes for this RFQ
    const { error: delErr } = await sb.from("quotes").delete().eq("rfq_id", rfqId);
    if (delErr) { alert(delErr.message); setBusy(false); return; }
    for (const q of quotes) {
      if (!q.supplierName.trim()) continue;
      const supplier = suppliers.find((s) => s.name.toLowerCase() === q.supplierName.trim().toLowerCase());
      const { data, error } = await sb
        .from("quotes")
        .insert({
          rfq_id: rfqId,
          supplier_name: q.supplierName.trim(),
          supplier_id: supplier?.id ?? null,
          notes: q.notes,
        })
        .select("id").single();
      if (error || !data) { alert(error?.message ?? "insert failed"); setBusy(false); return; }
      const rows = q.items
        .map((qi, k) => ({ qi, it: items[k] }))
        .filter(({ qi }) => qi.quoted)
        .map(({ qi, it }) => ({
          quote_id: data.id,
          rfq_item_id: it.id,
          thickness_raw: isMaterial ? qi.thicknessRaw : null,
          height_raw: isMaterial ? qi.heightRaw : null,
          length_raw: isMaterial ? qi.lengthRaw : null,
          qty: toNumber(qi.qty),
          price: toNumber(qi.price),
          notes: qi.notes,
        }));
      if (rows.length) {
        const { error: e2 } = await sb.from("quote_items").insert(rows);
        if (e2) { alert(e2.message); setBusy(false); return; }
      }
    }
    setBusy(false);
  }

  // ---------- Analysis ----------
  const result: ComparisonResult | null = useMemo(() => {
    if (!analysed || items.length === 0) return null;
    return analyseQuotes(
      items.map((it) => ({
        id: it.id,
        materialType: it.material_type ?? "",
        thicknessRaw: it.thickness_raw ?? "",
        heightRaw: it.height_raw ?? "",
        lengthRaw: it.length_raw ?? "",
        qty: it.qty,
        itemRef: it.item_ref ?? "",
      })),
      quotes
        .filter((q) => q.supplierName.trim())
        .map((q) => ({
          supplierName: q.supplierName.trim(),
          notes: q.notes,
          items: q.items
            .map((qi, k) => ({ qi, it: items[k] }))
            .filter(({ qi }) => qi.quoted && qi.price.trim() !== "")
            .map(({ qi, it }) => ({
              rfqItemId: it.id,
              thicknessRaw: qi.thicknessRaw,
              heightRaw: qi.heightRaw,
              lengthRaw: qi.lengthRaw,
              qty: toNumber(qi.qty),
              price: toNumber(qi.price),
              notes: qi.notes,
            })),
        }))
    );
  }, [analysed, items, quotes]);

  useEffect(() => {
    // Purchaser's Choice defaults to the recommendation but is never forced
    if (result?.recommended && !choice) setChoice(result.recommended.supplierName);
  }, [result, choice]);

  async function award() {
    if (!choice || !result) return;
    const chosen = result.suppliers.find((s) => s.supplierName === choice);
    const rfq = rfqs.find((r) => r.id === rfqId);
    const { data: userData } = await supabase().auth.getUser();
    const { error } = await supabase().from("purchase_history").insert({
      rfq_id: rfqId,
      ref: rfq?.subject ?? "",
      awarded_to: choice, // always the purchaser's choice
      total_rm: chosen?.total ?? null,
      notes: chosen?.notes ?? "",
      created_by: userData.user?.email ?? "",
    });
    if (error) alert(error.message);
    else setAwardMsg(`Awarded to ${choice} — recorded in Purchase History ✓ (editable there)`);
  }

  const rfq = rfqs.find((r) => r.id === rfqId);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-sm font-medium mb-1">RFQ</label>
          <select
            value={rfqId}
            onChange={(e) => loadRfq(e.target.value)}
            className="border rounded-lg px-3 py-2 min-w-64"
          >
            <option value="">Select an RFQ…</option>
            {rfqs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.subject || "(no subject)"} — {new Date(r.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </div>
        {rfqId && (
          <>
            <button onClick={addQuote} className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-100">
              + Supplier quotation
            </button>
            <button onClick={saveQuotes} disabled={busy} className="bg-gray-900 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
              💾 Save quotes
            </button>
            <button onClick={() => setAnalysed(true)} className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium">
              ⚙️ Analyse
            </button>
          </>
        )}
      </div>

      {rfqId && items.length === 0 && (
        <div className="text-sm text-gray-500">This RFQ has no items.</div>
      )}

      {/* Quote entry cards */}
      {quotes.map((q, i) => (
        <div key={i} className="bg-white border rounded-lg p-3 space-y-2">
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-56">
              <label className="block text-xs text-gray-500">{i + 1}. Supplier name</label>
              <input
                value={q.supplierName}
                onChange={(e) => setQuote(i, { supplierName: e.target.value })}
                list="supplier-names"
                placeholder="e.g. Lian Giap"
                className="w-full border rounded-lg px-2 py-1.5 text-sm font-medium"
              />
            </div>
            <div className="flex-[2] min-w-64">
              <label className="block text-xs text-gray-500">Supplier notes</label>
              <input
                value={q.notes}
                onChange={(e) => setQuote(i, { notes: e.target.value })}
                placeholder="e.g. Ex-stock, valid till tomorrow / No stock for item 2"
                className="w-full border rounded-lg px-2 py-1.5 text-sm"
              />
            </div>
            <button onClick={() => setQuotes(quotes.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 pb-1.5">✕</button>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="py-1 pr-2 w-20">Quoted?</th>
                <th className="py-1 pr-2">Item</th>
                {isMaterial && (
                  <>
                    <th className="py-1 pr-2">Thickness</th>
                    <th className="py-1 pr-2">Height</th>
                    <th className="py-1 pr-2">Length</th>
                  </>
                )}
                <th className="py-1 pr-2 w-16">Qty</th>
                <th className="py-1 pr-2 w-24">Price/pc RM</th>
                <th className="py-1">Item notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((it, k) => {
                const qi = q.items[k];
                if (!qi) return null;
                return (
                  <tr key={it.id} className={qi.quoted ? "" : "opacity-40"}>
                    <td className="py-1 pr-2">
                      <input
                        type="checkbox"
                        checked={qi.quoted}
                        onChange={(e) => setQuoteItem(i, k, { quoted: e.target.checked })}
                      />
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap">
                      <b>Item {k + 1}</b>{" "}
                      <span className="text-gray-500">
                        {isMaterial ? it.material_type : it.description}
                      </span>
                    </td>
                    {isMaterial && (
                      <>
                        <TdInput value={qi.thicknessRaw} disabled={!qi.quoted} inquiry={it.thickness_raw} onChange={(v) => setQuoteItem(i, k, { thicknessRaw: v })} />
                        <TdInput value={qi.heightRaw} disabled={!qi.quoted} inquiry={it.height_raw} onChange={(v) => setQuoteItem(i, k, { heightRaw: v })} />
                        <TdInput value={qi.lengthRaw} disabled={!qi.quoted} inquiry={it.length_raw} onChange={(v) => setQuoteItem(i, k, { lengthRaw: v })} />
                      </>
                    )}
                    <TdInput value={qi.qty} disabled={!qi.quoted} onChange={(v) => setQuoteItem(i, k, { qty: v })} />
                    <TdInput value={qi.price} disabled={!qi.quoted} onChange={(v) => setQuoteItem(i, k, { price: v })} />
                    <TdInput value={qi.notes} disabled={!qi.quoted} onChange={(v) => setQuoteItem(i, k, { notes: v })} placeholder="e.g. Quoted 3mm" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      <datalist id="supplier-names">
        {suppliers.map((s) => <option key={s.id} value={s.name} />)}
      </datalist>

      {/* ---------- Results ---------- */}
      {result && (
        <div className="space-y-6 pt-2">
          <Chart1 result={result} items={items} isMaterial={isMaterial} choice={choice} />
          {isMaterial && <Chart2 result={result} />}
          {isMaterial && <Chart3 result={result} items={items} />}

          <div className="bg-white border-2 border-blue-200 rounded-lg p-4 space-y-3">
            <div>
              <div className="text-sm text-gray-500">Claude&apos;s Choice</div>
              <div className="font-bold text-lg">
                {result.recommended
                  ? `${result.recommended.supplierName} — ${rm(result.recommended.total)}`
                  : "—"}
              </div>
              <div className="text-sm text-gray-600">{result.reasoning}</div>
            </div>
            <div className="flex gap-3 items-end flex-wrap border-t pt-3">
              <div>
                <label className="block text-sm font-medium mb-1">Purchaser&apos;s Choice (final)</label>
                <select value={choice} onChange={(e) => setChoice(e.target.value)} className="border rounded-lg px-3 py-2">
                  {result.suppliers.map((s) => (
                    <option key={s.supplierName} value={s.supplierName}>
                      {s.supplierName} — {rm(s.total)}
                    </option>
                  ))}
                </select>
              </div>
              <button onClick={award} disabled={!choice} className="bg-green-600 hover:bg-green-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
                🏆 Award &amp; record in Purchase History
              </button>
              {awardMsg && <span className="text-green-700 text-sm pb-2">{awardMsg}</span>}
            </div>
            {rfq && <div className="text-xs text-gray-400">Ref: {rfq.subject}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function TdInput({
  value, onChange, disabled, inquiry, placeholder,
}: {
  value: string; onChange: (v: string) => void; disabled: boolean;
  inquiry?: string | null; placeholder?: string;
}) {
  const differs =
    inquiry != null && inquiry !== "" && value.trim() !== "" && value.trim() !== inquiry.trim();
  return (
    <td className="py-1 pr-2">
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? inquiry ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full border rounded px-2 py-1 text-sm ${differs ? "border-amber-400 bg-amber-50" : ""}`}
        title={differs ? `Inquiry asked: ${inquiry}` : undefined}
      />
    </td>
  );
}

/* CHART 1 — As Quoted */
function Chart1({
  result, items, isMaterial, choice,
}: {
  result: ComparisonResult; items: RfqItemRow[]; isMaterial: boolean; choice: string;
}) {
  return (
    <div>
      <h3 className="font-bold mb-2">CHART 1 — As Quoted</h3>
      <div className="overflow-x-auto bg-white border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2">Supplier</th>
              {items.map((_, i) => <th key={i} className="px-3 py-2">Item {i + 1} /pc</th>)}
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Coverage</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {result.suppliers.map((s) => {
              const isRec = s === result.recommended;
              const isChoice = s.supplierName === choice;
              return (
                <tr key={s.supplierName} className={isRec ? "bg-green-50" : ""}>
                  <td className="px-3 py-2 font-medium">
                    {s.supplierName} {isRec && "🏆"} {isChoice && !isRec && "✅"}
                  </td>
                  {s.items.map((it, i) => (
                    <td key={i} className="px-3 py-2">
                      {it.quoted?.price != null ? rm(it.quoted.price) : <span className="text-gray-300">not quoted</span>}
                      {it.quoted && !it.specOk && isMaterial && <span title="off-spec"> ⚠</span>}
                    </td>
                  ))}
                  <td className="px-3 py-2 font-bold">{rm(s.total)}</td>
                  <td className="px-3 py-2">{s.quotedCount}/{items.length}{!s.fullCoverage && " ⚠"}</td>
                  <td className="px-3 py-2 text-gray-500">{s.notes || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* CHART 2 — Normalised RM/kg */
function Chart2({ result }: { result: ComparisonResult }) {
  const rows = result.suppliers.slice().sort((a, b) => (a.rmPerKg ?? Infinity) - (b.rmPerKg ?? Infinity));
  return (
    <div>
      <h3 className="font-bold mb-2">CHART 2 — Normalised RM/kg (the fair ruler)</h3>
      <div className="overflow-x-auto bg-white border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Total RM</th>
              <th className="px-3 py-2">Total kg</th>
              <th className="px-3 py-2">RM / kg</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((s) => (
              <tr key={s.supplierName} className={s === result.recommended ? "bg-green-50" : ""}>
                <td className="px-3 py-2 font-medium">{s.supplierName}{s === result.recommended && " 🏆"}</td>
                <td className="px-3 py-2">{rm(s.total)}</td>
                <td className="px-3 py-2">{s.weightKg > 0 ? s.weightKg.toFixed(3) : "—"}</td>
                <td className="px-3 py-2 font-bold">{s.rmPerKg != null ? rm(s.rmPerKg) : "n/a"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400 mt-1">
        Weight: T×H×L×0.000008 (rect) / Ø²×L×0.0000066 (round) at steel density, scaled by material. Plastics: no RM/kg.
      </p>
    </div>
  );
}

/* CHART 3 — Closest to Inquiry (spec match, ALL dimensions) */
function Chart3({ result, items }: { result: ComparisonResult; items: RfqItemRow[] }) {
  return (
    <div>
      <h3 className="font-bold mb-2">CHART 3 — Closest to Inquiry (spec match)</h3>
      {items.map((it, k) => (
        <div key={it.id} className="mb-4">
          <div className="text-sm text-gray-500 mb-1">
            Item {k + 1} — inquiry: {it.material_type} {it.thickness_raw} × {it.height_raw} × {it.length_raw}, {it.qty} PCS
          </div>
          <div className="overflow-x-auto bg-white border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 text-left">
                <tr>
                  <th className="px-3 py-2">Supplier</th>
                  <th className="px-3 py-2">Thickness</th>
                  <th className="px-3 py-2">Height</th>
                  <th className="px-3 py-2">Length</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr className="bg-blue-50">
                  <td className="px-3 py-2 font-medium">🎯 Your inquiry</td>
                  <td className="px-3 py-2">{it.thickness_raw}</td>
                  <td className="px-3 py-2">{it.height_raw}</td>
                  <td className="px-3 py-2">{it.length_raw}</td>
                  <td className="px-3 py-2">{it.qty}</td>
                  <td className="px-3 py-2">—</td>
                </tr>
                {result.suppliers.map((s) => {
                  const a = s.items[k];
                  if (!a.quoted) {
                    return (
                      <tr key={s.supplierName} className="text-gray-300">
                        <td className="px-3 py-2">{s.supplierName}</td>
                        <td className="px-3 py-2" colSpan={5}>not quoted</td>
                      </tr>
                    );
                  }
                  const mark = (ok: boolean, v: string) => (
                    <td className={`px-3 py-2 ${ok ? "text-green-700" : "text-red-600 font-bold"}`}>
                      {v || "—"} {ok ? "✓" : "✗"}
                    </td>
                  );
                  const missing: string[] = [];
                  if (!a.thicknessOk) missing.push("thickness");
                  if (!a.heightOk) missing.push("height");
                  if (!a.lengthOk) missing.push("length");
                  if (!a.qtyOk) missing.push("qty");
                  return (
                    <tr key={s.supplierName}>
                      <td className="px-3 py-2 font-medium">{s.supplierName}</td>
                      {mark(a.thicknessOk, a.quoted.thicknessRaw)}
                      {mark(a.heightOk, a.quoted.heightRaw)}
                      {mark(a.lengthOk, a.quoted.lengthRaw)}
                      {mark(a.qtyOk, a.quoted.qty == null ? "" : String(a.quoted.qty))}
                      <td className={`px-3 py-2 font-medium ${a.specOk ? "text-green-700" : "text-amber-600"}`}>
                        {a.specOk ? "exact" : missing.join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

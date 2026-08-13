"use client";

/* Tabs 3 & 4 — Quote Comparison (Material / General).
 *
 * Handles what the client's spec demonstrates: suppliers quoting different
 * dimensions than asked (off-spec, flagged not hidden) and skipping items
 * entirely ("No stock for item 2").
 *
 * The tool recommends ("Claude's Choice") but the purchaser decides
 * ("always follow purchaser's choice"); Award writes Purchase History.
 *
 * Quotes persist through syncRows() rather than delete-and-reinsert, so a
 * failed save can no longer wipe quotes that were already stored.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { RfqKind, RfqRow, RfqItemRow, QuoteRow, QuoteItemRow, SupplierRow } from "@/lib/types";
import { analyseQuotes, byRmPerKg, type ComparisonResult, type SupplierAnalysis } from "@/lib/compare";
import { parseQty, parsePrice } from "@/lib/num";
import { debounce, syncRows, type SaveState } from "@/lib/persist";
import SaveIndicator from "./SaveIndicator";
import { SAMPLE_MATERIAL_QUOTES, SAMPLE_GENERAL_QUOTES } from "@/lib/sample";

interface QuoteItemDraft {
  id?: string;
  quoted: boolean;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: string;
  price: string;
  notes: string;
}

interface QuoteDraft {
  id?: string;
  supplierName: string;
  notes: string;
  items: QuoteItemDraft[]; // parallel to rfq items
  knownItemIds: string[];
}

const rm = (n: number) => "RM " + n.toFixed(2);

export default function CompareEditor({ kind }: { kind: RfqKind }) {
  const isMaterial = kind === "material";
  const searchParams = useSearchParams();
  const requestedRfq = searchParams.get("rfq");

  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [rfqId, setRfqId] = useState("");
  const [items, setItems] = useState<RfqItemRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteDraft[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [pageError, setPageError] = useState("");
  const [choice, setChoice] = useState("");
  const [awardMsg, setAwardMsg] = useState("");
  const [awarding, setAwarding] = useState(false);

  const knownQuoteIds = useRef<string[]>([]);
  const loading = useRef(false);
  const dirty = useRef(false);

  // ---------- initial lists ----------
  useEffect(() => {
    let alive = true;
    const sb = supabase();
    (async () => {
      const [r, s] = await Promise.all([
        sb.from("rfqs").select("*").eq("kind", kind).order("created_at", { ascending: false }).limit(200),
        sb.from("suppliers").select("*").order("name"),
      ]);
      if (!alive) return;
      if (r.error) setPageError(r.error.message);
      else setRfqs((r.data as RfqRow[]) ?? []);
      if (!s.error) setSuppliers((s.data as SupplierRow[]) ?? []);
    })();
    return () => { alive = false; };
  }, [kind]);

  // ---------- load a round ----------
  const loadRfq = useCallback(async (id: string) => {
    loading.current = true;
    dirty.current = false;
    setRfqId(id);
    setAwardMsg("");
    setChoice("");
    setSaveState("idle");
    if (!id) { setItems([]); setQuotes([]); loading.current = false; return; }

    const sb = supabase();
    const [{ data: its, error: e1 }, { data: qs, error: e2 }] = await Promise.all([
      sb.from("rfq_items").select("*").eq("rfq_id", id).order("position"),
      sb.from("quotes").select("*, quote_items(*)").eq("rfq_id", id).order("created_at"),
    ]);
    if (e1 || e2) {
      setPageError(e1?.message ?? e2?.message ?? "could not load");
      loading.current = false;
      return;
    }
    const rfqItems = (its as RfqItemRow[]) ?? [];
    setItems(rfqItems);
    type QuoteWithItems = QuoteRow & { quote_items: QuoteItemRow[] };
    const loaded = ((qs ?? []) as QuoteWithItems[]).map((q) => ({
      id: q.id,
      supplierName: q.supplier_name,
      notes: q.notes,
      knownItemIds: q.quote_items.map((x) => x.id),
      items: rfqItems.map((it) => {
        const qi = q.quote_items.find((x) => x.rfq_item_id === it.id);
        return qi
          ? {
              id: qi.id, quoted: true,
              thicknessRaw: qi.thickness_raw ?? "",
              heightRaw: qi.height_raw ?? "",
              lengthRaw: qi.length_raw ?? "",
              qty: qi.qty == null ? "" : String(qi.qty),
              price: qi.price == null ? "" : String(qi.price),
              notes: qi.notes,
            }
          : blankQuoteItem(it, false);
      }),
    }));
    knownQuoteIds.current = loaded.map((q) => q.id as string);
    setQuotes(loaded);
    setPageError("");
    setTimeout(() => { loading.current = false; }, 0);
  }, []);

  // Preselect: ?rfq= from the RFQ editor, else the most recent round.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || rfqs.length === 0) return;
    preselected.current = true;
    const target = requestedRfq && rfqs.some((r) => r.id === requestedRfq)
      ? requestedRfq
      : rfqs[0].id;
    loadRfq(target);
  }, [rfqs, requestedRfq, loadRfq]);

  function blankQuoteItem(it: RfqItemRow, quoted: boolean): QuoteItemDraft {
    return {
      quoted,
      thicknessRaw: it.thickness_raw ?? "",
      heightRaw: it.height_raw ?? "",
      lengthRaw: it.length_raw ?? "",
      qty: it.qty == null ? "" : String(it.qty),
      price: "",
      notes: "",
    };
  }

  // ---------- persistence ----------
  const persist = useCallback(async (rid: string, qs: QuoteDraft[]) => {
    if (!rid) return;
    const sb = supabase();
    setSaveState("saving");

    const named = qs.filter((q) => q.supplierName.trim() !== "");
    const headerRows = named.map((q) => ({
      ...(q.id ? { id: q.id } : {}),
      rfq_id: rid,
      supplier_name: q.supplierName.trim(),
      supplier_id: suppliers.find(
        (s) => s.name.toLowerCase() === q.supplierName.trim().toLowerCase()
      )?.id ?? null,
      notes: q.notes,
    }));

    const { ids, error } = await syncRows(sb, "quotes", headerRows, knownQuoteIds.current);
    if (error) { setSaveState("error"); setSaveError(error.message); return; }
    knownQuoteIds.current = ids;

    for (let n = 0; n < named.length; n++) {
      const q = named[n];
      const quoteId = ids[n];
      const rows = q.items
        .map((qi, k) => ({ qi, it: items[k] }))
        .filter(({ qi, it }) => qi.quoted && !!it)
        .map(({ qi, it }) => ({
          ...(qi.id ? { id: qi.id } : {}),
          quote_id: quoteId,
          rfq_item_id: it.id,
          thickness_raw: isMaterial ? qi.thicknessRaw : null,
          height_raw: isMaterial ? qi.heightRaw : null,
          length_raw: isMaterial ? qi.lengthRaw : null,
          qty: parseQty(qi.qty),
          price: parsePrice(qi.price),
          notes: qi.notes,
        }));
      const res = await syncRows(sb, "quote_items", rows, q.knownItemIds);
      if (res.error) { setSaveState("error"); setSaveError(res.error.message); return; }
      q.knownItemIds = res.ids;
      let c = 0;
      q.items.forEach((qi) => { if (qi.quoted && !qi.id) qi.id = res.ids[c]; if (qi.quoted) c++; });
    }

    // Attach new header ids so the next save updates rather than re-inserts.
    // Return the SAME array when nothing changed — always returning a new one
    // changes `quotes` identity, refiring the autosave effect in a loop.
    setQuotes((prev) => {
      let n = 0;
      let changed = false;
      const next = prev.map((q) => {
        if (q.supplierName.trim() === "") return q;
        const id = ids[n++];
        if (q.id === id) return q;
        changed = true;
        return { ...q, id };
      });
      return changed ? next : prev;
    });
    setSaveState("saved");
    setSaveError("");
  }, [items, isMaterial, suppliers]);

  /* The timer is created once and stays free of refs and state; every guard
   * lives in the effect below, which may read refs legitimately. */
  const autosave = useMemo(
    () => debounce(
      (save: typeof persist, rid: string, qs: QuoteDraft[]) => save(rid, qs),
      800
    ),
    []
  );

  useEffect(() => {
    if (loading.current || !dirty.current || !rfqId) return;
    // Cleared on scheduling — see the matching note in RfqEditor: a settled
    // state must never resave, or attaching ids would loop.
    dirty.current = false;
    autosave(persist, rfqId, quotes);
  }, [quotes, rfqId, autosave, persist]);

  useEffect(() => () => autosave.cancel(), [autosave]);

  function touch() { dirty.current = true; }

  // ---------- editing ----------
  function addQuote() {
    touch();
    setQuotes((prev) => [...prev, {
      supplierName: "", notes: "", knownItemIds: [],
      items: items.map((it) => blankQuoteItem(it, true)),
    }]);
  }
  function loadExampleQuotes() {
    touch();
    const src = isMaterial ? SAMPLE_MATERIAL_QUOTES : SAMPLE_GENERAL_QUOTES;
    setQuotes(src.map((s) => ({
      supplierName: s.supplierName,
      notes: s.notes,
      knownItemIds: [],
      items: items.map((it, k) => {
        const line = s.lines[k];
        if (!line) return blankQuoteItem(it, false);
        const b = blankQuoteItem(it, true);
        return {
          ...b,
          thicknessRaw: line.thicknessRaw ?? b.thicknessRaw,
          heightRaw: line.heightRaw ?? b.heightRaw,
          lengthRaw: line.lengthRaw ?? b.lengthRaw,
          price: line.price,
        };
      }),
    })));
  }
  function setQuote(i: number, patch: Partial<QuoteDraft>) {
    touch();
    setQuotes((prev) => prev.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  }
  function setQuoteItem(i: number, k: number, patch: Partial<QuoteItemDraft>) {
    touch();
    setQuotes((prev) => prev.map((q, j) =>
      j === i ? { ...q, items: q.items.map((qi, l) => (l === k ? { ...qi, ...patch } : qi)) } : q
    ));
  }
  async function removeQuote(i: number) {
    const q = quotes[i];
    if (q.id && !confirm(`Remove ${q.supplierName || "this supplier"}'s quote?`)) return;
    touch();
    setQuotes((prev) => prev.filter((_, j) => j !== i));
  }

  // ---------- analysis (always live — no Analyse latch) ----------
  const result: ComparisonResult | null = useMemo(() => {
    if (items.length === 0) return null;
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
            .filter(({ qi, it }) => !!it && qi.quoted && parsePrice(qi.price) != null)
            .map(({ qi, it }) => ({
              rfqItemId: it.id,
              thicknessRaw: qi.thicknessRaw,
              heightRaw: qi.heightRaw,
              lengthRaw: qi.lengthRaw,
              qty: parseQty(qi.qty),
              price: parsePrice(qi.price),
              notes: qi.notes,
            })),
        }))
    );
  }, [items, quotes]);

  // Purchaser's Choice defaults to the recommendation, but is revalidated
  // whenever the analysis changes — a stale name would otherwise award a
  // supplier who no longer exists, writing a null total to purchase history.
  useEffect(() => {
    if (!result) return;
    const valid = result.suppliers.some((s) => s.supplierName === choice);
    if (!valid) setChoice(result.recommended?.supplierName ?? "");
  }, [result, choice]);

  const chosen = result?.suppliers.find((s) => s.supplierName === choice) ?? null;

  async function award() {
    if (!chosen || awarding) return;
    setAwarding(true);
    const rfq = rfqs.find((r) => r.id === rfqId);
    const { data: userData } = await supabase().auth.getUser();
    const { error } = await supabase().from("purchase_history").insert({
      rfq_id: rfqId,
      ref: rfq?.subject ?? "",
      awarded_to: chosen.supplierName,
      total_rm: chosen.total,
      notes: chosen.notes,
      created_by: userData.user?.email ?? "",
    });
    setAwarding(false);
    if (error) { setPageError(error.message); return; }
    setAwardMsg(`Awarded to ${chosen.supplierName} — recorded in Purchase History ✓`);
  }

  const rfq = rfqs.find((r) => r.id === rfqId);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label htmlFor="cmp-rfq" className="lbl">RFQ</label>
          <select
            id="cmp-rfq"
            value={rfqId}
            onChange={(e) => loadRfq(e.target.value)}
            className="fld min-w-56"
          >
            {rfqs.length === 0 && <option value="">No RFQs yet</option>}
            {rfqs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.subject || "(no subject)"} — {new Date(r.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </div>
        {rfqId && (
          <>
            <button onClick={addQuote} className="btn-ghost text-sm">+ Supplier quotation</button>
            {items.length > 0 && (
              <button onClick={loadExampleQuotes} className="btn-ghost text-sm">📋 Load example</button>
            )}
            <SaveIndicator state={saveState} error={saveError} onRetry={() => persist(rfqId, quotes)} />
          </>
        )}
      </div>

      {pageError && <div className="flag" role="alert">{pageError}</div>}
      {rfqId && items.length === 0 && (
        <div className="text-sm text-gray-500">This RFQ has no items yet.</div>
      )}

      {/* Quote entry */}
      {quotes.map((q, i) => (
        <div key={q.id ?? `new-${i}`} className="card space-y-2">
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-52">
              <label htmlFor={`sup-${i}`} className="lbl">{i + 1}. Supplier name</label>
              <input
                id={`sup-${i}`}
                value={q.supplierName}
                onChange={(e) => setQuote(i, { supplierName: e.target.value })}
                list="supplier-names"
                placeholder="e.g. Lian Giap"
                className="w-full fld text-sm font-medium"
              />
            </div>
            <div className="flex-[2] min-w-56">
              <label htmlFor={`note-${i}`} className="lbl">Supplier notes</label>
              <input
                id={`note-${i}`}
                value={q.notes}
                onChange={(e) => setQuote(i, { notes: e.target.value })}
                placeholder="e.g. Ex-stock, valid till tomorrow"
                className="w-full fld text-sm"
              />
            </div>
            <button
              onClick={() => removeQuote(i)}
              aria-label={`Remove ${q.supplierName || "supplier"} quotation`}
              className="text-red-400 hover:text-red-600 px-2 py-2"
            >
              ✕
            </button>
          </div>
          {q.supplierName.trim() === "" && (
            <div className="text-xs text-amber-700">
              Give this supplier a name — unnamed quotes are not saved.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th scope="col" className="py-1 pr-2 w-16">Quoted?</th>
                  <th scope="col" className="py-1 pr-2">Item</th>
                  {isMaterial && (<>
                    <th scope="col" className="py-1 pr-2">Thickness</th>
                    <th scope="col" className="py-1 pr-2">Height</th>
                    <th scope="col" className="py-1 pr-2">Length</th>
                  </>)}
                  <th scope="col" className="py-1 pr-2 w-16">Qty</th>
                  <th scope="col" className="py-1 pr-2 w-24">Price/pc RM</th>
                  <th scope="col" className="py-1">Item notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((it, k) => {
                  const qi = q.items[k];
                  if (!qi) return null;
                  const label = `${isMaterial ? it.material_type : it.description} item ${k + 1}`;
                  return (
                    <tr key={it.id} className={qi.quoted ? "" : "opacity-40"}>
                      <td className="py-1 pr-2">
                        <input
                          type="checkbox"
                          checked={qi.quoted}
                          aria-label={`${label} quoted`}
                          onChange={(e) => setQuoteItem(i, k, { quoted: e.target.checked })}
                        />
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <b>Item {k + 1}</b>{" "}
                        <span className="text-gray-500">{isMaterial ? it.material_type : it.description}</span>
                      </td>
                      {isMaterial && (<>
                        <TdInput label={`${label} thickness`} value={qi.thicknessRaw} disabled={!qi.quoted} inquiry={it.thickness_raw} onChange={(v) => setQuoteItem(i, k, { thicknessRaw: v })} />
                        <TdInput label={`${label} height`} value={qi.heightRaw} disabled={!qi.quoted} inquiry={it.height_raw} onChange={(v) => setQuoteItem(i, k, { heightRaw: v })} />
                        <TdInput label={`${label} length`} value={qi.lengthRaw} disabled={!qi.quoted} inquiry={it.length_raw} onChange={(v) => setQuoteItem(i, k, { lengthRaw: v })} />
                      </>)}
                      <TdInput label={`${label} quantity`} value={qi.qty} disabled={!qi.quoted} onChange={(v) => setQuoteItem(i, k, { qty: v })} />
                      <TdInput label={`${label} price`} value={qi.price} disabled={!qi.quoted} invalid={qi.quoted && qi.price.trim() !== "" && parsePrice(qi.price) == null} onChange={(v) => setQuoteItem(i, k, { price: v })} />
                      <TdInput label={`${label} notes`} value={qi.notes} disabled={!qi.quoted} onChange={(v) => setQuoteItem(i, k, { notes: v })} placeholder="e.g. Quoted 3mm" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <datalist id="supplier-names">
        {suppliers.map((s) => <option key={s.id} value={s.name} />)}
      </datalist>

      {/* ---------- Results ---------- */}
      {result && result.suppliers.length > 0 && (
        <div className="space-y-6 pt-2">
          <Chart1 result={result} items={items} isMaterial={isMaterial} choice={choice} />
          {isMaterial && <Chart2 result={result} />}
          {isMaterial && <Chart3 result={result} items={items} />}

          <div className="verdict">
            <div className="text-xs uppercase tracking-wide text-gray-600">Claude&apos;s Choice</div>
            <h3 className="font-bold text-lg">
              {result.recommended
                ? `${result.recommended.supplierName} — ${rm(result.recommended.total)}`
                : "No comparable quote yet"}
            </h3>
            <div className="text-sm">{result.reasoning}</div>

            <div className="flex gap-3 items-end flex-wrap border-t border-green-200 pt-3 mt-3">
              <div>
                <label htmlFor="purchaser-choice" className="lbl">Purchaser&apos;s Choice (final)</label>
                <select
                  id="purchaser-choice"
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  className="fld"
                >
                  <option value="">— select —</option>
                  {result.suppliers.map((s) => (
                    <option key={s.supplierName} value={s.supplierName}>
                      {s.supplierName} — {rm(s.total)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={award}
                disabled={!chosen || awarding}
                className="btn-award disabled:opacity-50"
              >
                {awarding ? "Recording…" : "🏆 Award & record in Purchase History"}
              </button>
              {awardMsg && <span className="text-green-800 text-sm pb-2">{awardMsg}</span>}
            </div>
            {rfq && <div className="text-xs text-gray-500 mt-1">Ref: {rfq.subject}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function TdInput({
  label, value, onChange, disabled, inquiry, placeholder, invalid,
}: {
  label: string; value: string; onChange: (v: string) => void; disabled: boolean;
  inquiry?: string | null; placeholder?: string; invalid?: boolean;
}) {
  const differs =
    inquiry != null && inquiry !== "" && value.trim() !== "" && value.trim() !== inquiry.trim();
  return (
    <td className="py-1 pr-2">
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? inquiry ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full fld text-sm ${invalid ? "border-red-500 bg-red-50" : differs ? "border-amber-400 bg-amber-50" : ""}`}
        title={invalid ? "Not a valid number" : differs ? `Inquiry asked: ${inquiry}` : undefined}
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
      <div className="chart-title">CHART 1 — As Quoted</div>
      <div className="overflow-x-auto tbl-wrap">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Supplier</th>
              {items.map((_, i) => <th scope="col" key={i}>Item {i + 1} /pc</th>)}
              <th scope="col">Total</th>
              <th scope="col">Coverage</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {result.suppliers.map((s) => {
              const isRec = s === result.recommended;
              const isChoice = s.supplierName === choice;
              return (
                <tr key={s.supplierName} className={isRec ? "win-row" : ""}>
                  <td className="font-medium">
                    {s.supplierName} {isRec && "🏆"} {isChoice && !isRec && "✅"}
                  </td>
                  {s.items.map((it, i) => (
                    <td key={i}>
                      {it.quoted?.price != null ? rm(it.quoted.price) : <span className="text-gray-400">not quoted</span>}
                      {it.quoted && !it.specOk && isMaterial && <span title="off-spec" className="miss"> ⚠</span>}
                    </td>
                  ))}
                  <td className="font-bold">{rm(s.total)}</td>
                  <td className={s.fullCoverage ? "" : "miss"}>
                    {s.quotedCount}/{items.length}{!s.fullCoverage && " ⚠"}
                  </td>
                  <td className="text-gray-600">{s.notes || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {result.suppliers.some((s) => s.issues.length > 0) && (
        <div className="flag">
          {result.suppliers.flatMap((s) =>
            s.issues.map((m) => <div key={s.supplierName + m}><b>{s.supplierName}</b> — {m}</div>)
          )}
        </div>
      )}
    </div>
  );
}

/* CHART 2 — Normalised RM/kg */
function Chart2({ result }: { result: ComparisonResult }) {
  const rows = result.suppliers.slice().sort(byRmPerKg);
  return (
    <div>
      <div className="chart-title">CHART 2 — Normalised RM/kg (the fair ruler)</div>
      <div className="overflow-x-auto tbl-wrap">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Supplier</th>
              <th scope="col">Total RM</th>
              <th scope="col">Total kg</th>
              <th scope="col">RM / kg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s: SupplierAnalysis) => (
              <tr key={s.supplierName} className={s === result.recommended ? "win-row" : ""}>
                <td className="font-medium">{s.supplierName}{s === result.recommended && " 🏆"}</td>
                <td>{rm(s.total)}</td>
                <td>{s.weightKg > 0 ? s.weightKg.toFixed(3) : "—"}</td>
                <td className="font-bold">
                  {s.rmPerKg != null ? rm(s.rmPerKg) : <span className="text-gray-500">n/a</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Weight: T×H×L×0.000008 (rect) / Ø²×L×0.0000066 (round) at steel density, scaled by
        material. RM/kg is only shown when every priced line has a computable weight —
        plastics have none, so a mixed basket would otherwise inflate it.
        {result.rankedBy === "total" && " Ranking used total RM, not RM/kg."}
      </p>
    </div>
  );
}

/* CHART 3 — Closest to Inquiry (spec match, ALL dimensions) */
function Chart3({ result, items }: { result: ComparisonResult; items: RfqItemRow[] }) {
  return (
    <div>
      <div className="chart-title">CHART 3 — Closest to Inquiry (spec match)</div>
      {items.map((it, k) => (
        <div key={it.id} className="mb-4">
          <div className="hint mb-1">
            Item {k + 1} — inquiry: {it.material_type} {it.thickness_raw} × {it.height_raw} × {it.length_raw}, {it.qty} PCS
          </div>
          <div className="overflow-x-auto tbl-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col">Supplier</th>
                  <th scope="col">Thickness</th>
                  <th scope="col">Height</th>
                  <th scope="col">Length</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Match</th>
                </tr>
              </thead>
              <tbody>
                <tr className="inq-row">
                  <td className="font-medium">🎯 Your inquiry</td>
                  <td>{it.thickness_raw}</td>
                  <td>{it.height_raw}</td>
                  <td>{it.length_raw}</td>
                  <td>{it.qty}</td>
                  <td>—</td>
                </tr>
                {result.suppliers.map((s) => {
                  const a = s.items[k];
                  if (!a?.quoted) {
                    return (
                      <tr key={s.supplierName} className="text-gray-400">
                        <td>{s.supplierName}</td>
                        <td colSpan={5}>not quoted</td>
                      </tr>
                    );
                  }
                  const mark = (ok: boolean, v: string) => (
                    <td className={ok ? "match" : "miss"}>{v || "—"} {ok ? "✓" : "✗"}</td>
                  );
                  const missing: string[] = [];
                  if (!a.thicknessOk) missing.push("thickness");
                  if (!a.heightOk) missing.push("height");
                  if (!a.lengthOk) missing.push("length");
                  if (!a.qtyOk) missing.push("qty");
                  return (
                    <tr key={s.supplierName}>
                      <td className="font-medium">{s.supplierName}</td>
                      {mark(a.thicknessOk, a.quoted.thicknessRaw)}
                      {mark(a.heightOk, a.quoted.heightRaw)}
                      {mark(a.lengthOk, a.quoted.lengthRaw)}
                      {mark(a.qtyOk, a.quoted.qty == null ? "" : String(a.quoted.qty))}
                      <td className={a.specOk ? "match" : "miss"}>
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

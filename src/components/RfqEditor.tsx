"use client";

/* Shared editor for Tab 1 (RFQ Material) and Tab 2 (RFQ General).
 *
 * Material items carry per-item material + dims + per-item Ref, and get
 * suggested supplier emails from the Supplier List. Dimension notation —
 * "(9.50)" order size, "Ø4.00" diameter — is kept verbatim from input through
 * to the generated email.
 *
 * Saving goes through syncRows() rather than delete-and-reinsert, so
 * rfq_items.id stays stable and the supplier quotes referencing them survive
 * an edit. See src/lib/persist.ts for why that matters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import type { RfqKind, RfqRow, RfqItemRow } from "@/lib/types";
import { useSupplierData } from "@/lib/useSupplierData";
import { suggestSuppliers } from "@/lib/supplierMatch";
import { parseQty } from "@/lib/num";
import { debounce, syncRows, type SaveState } from "@/lib/persist";
import SaveIndicator from "./SaveIndicator";
import {
  buildGeneralEmail, buildMaterialEmail, gmailComposeUrl, mailtoUrl, mailUrlTooLong,
} from "@/lib/email";
import {
  SAMPLE_GENERAL_ITEMS, SAMPLE_GENERAL_SUBJECT,
  SAMPLE_MATERIAL_ITEMS, SAMPLE_MATERIAL_SUBJECT,
} from "@/lib/sample";

interface ItemDraft {
  /** Server id; absent until the row has been inserted. */
  id?: string;
  materialType: string;
  description: string;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: string;
  itemRef: string;
}

const BLANK: ItemDraft = {
  materialType: "", description: "", thicknessRaw: "", heightRaw: "",
  lengthRaw: "", qty: "", itemRef: "",
};

function todaySubject() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `RFQ ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export default function RfqEditor({ kind }: { kind: RfqKind }) {
  const isMaterial = kind === "material";
  const { groups } = useSupplierData();

  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([{ ...BLANK }]);
  const [recipients, setRecipients] = useState("");
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [listError, setListError] = useState("");
  const [copied, setCopied] = useState(false);

  /** rfq_items ids last seen on the server, for delete detection. */
  const knownItemIds = useRef<string[]>([]);
  /** Suppress autosave while programmatically loading. */
  const loading = useRef(false);
  /** Set by touch() on any user edit; cleared when a save is dispatched. */
  const dirty = useRef(false);

  const loadList = useCallback(async () => {
    const { data, error } = await supabase()
      .from("rfqs").select("*").eq("kind", kind)
      .order("created_at", { ascending: false }).limit(200);
    if (error) { setListError(error.message); return; }
    setListError("");
    setRfqs((data as RfqRow[]) ?? []);
  }, [kind]);

  useEffect(() => { loadList(); }, [loadList]);

  // ---------- persistence ----------
  const persist = useCallback(async (
    id: string | null, subj: string, its: ItemDraft[]
  ): Promise<string | null> => {
    const sb = supabase();
    setSaveState("saving");
    let rfqId = id;

    if (rfqId) {
      const { error } = await sb.from("rfqs").update({ subject: subj }).eq("id", rfqId);
      if (error) { setSaveState("error"); setSaveError(error.message); return null; }
    } else {
      const { data: userData } = await sb.auth.getUser();
      const { data, error } = await sb.from("rfqs")
        .insert({ kind, subject: subj, created_by: userData.user?.email ?? "" })
        .select("id").single();
      if (error || !data) {
        setSaveState("error"); setSaveError(error?.message ?? "could not create RFQ");
        return null;
      }
      rfqId = data.id as string;
      setCurrentId(rfqId);
    }

    const rows = its.map((it, i) => ({
      ...(it.id ? { id: it.id } : {}),
      rfq_id: rfqId,
      position: i,
      material_type: isMaterial ? it.materialType : null,
      description: isMaterial ? null : it.description,
      thickness_raw: isMaterial ? it.thicknessRaw : null,
      height_raw: isMaterial ? it.heightRaw : null,
      length_raw: isMaterial ? it.lengthRaw : null,
      qty: parseQty(it.qty),
      item_ref: it.itemRef,
    }));

    const { ids, error } = await syncRows(sb, "rfq_items", rows, knownItemIds.current);
    if (error) { setSaveState("error"); setSaveError(error.message); return null; }

    knownItemIds.current = ids;
    // Return the SAME array when no id was attached. Always returning a new
    // array changes `items` identity, which refires the autosave effect and
    // loops: save → setItems → effect → save …
    setItems((prev) => {
      let changed = false;
      const next = prev.map((it, i) => {
        if (it.id) return it;
        changed = true;
        return { ...it, id: ids[i] };
      });
      return changed ? next : prev;
    });
    setSaveState("saved");
    setSaveError("");
    loadList();
    return rfqId;
  }, [isMaterial, kind, loadList]);

  /* The timer is created once and stays free of refs and state; every guard
   * lives in the effect below, which may read refs legitimately. */
  const autosave = useMemo(
    () => debounce((
      save: typeof persist, id: string | null, subj: string, its: ItemDraft[]
    ) => save(id, subj, its), 800),
    []
  );

  useEffect(() => {
    if (loading.current || !dirty.current) return;
    // Don't create an empty RFQ just because the page rendered.
    const hasContent = subject.trim() !== "" || items.some((it) =>
      it.materialType || it.description || it.thicknessRaw || it.heightRaw ||
      it.lengthRaw || it.qty || it.itemRef);
    if (!currentId && !hasContent) return;
    // Cleared on scheduling: an edit during the debounce window sets it again
    // and reschedules, while a settled state never resaves — which would loop,
    // because a successful save updates `items` with its new ids.
    dirty.current = false;
    autosave(persist, currentId, subject, items);
  }, [subject, items, currentId, autosave, persist]);

  useEffect(() => () => autosave.cancel(), [autosave]);

  function touch() { dirty.current = true; }

  // ---------- loading / new ----------
  function newRfq() {
    loading.current = true;
    autosave.cancel();
    dirty.current = false;
    knownItemIds.current = [];
    setCurrentId(null);
    setSubject(todaySubject());
    setItems([{ ...BLANK }]);
    setPreview(null);
    setRecipients("");
    setSaveState("idle");
    setSaveError("");
    setTimeout(() => { loading.current = false; }, 0);
  }

  const openRfq = useCallback(async (id: string) => {
    loading.current = true;
    autosave.cancel();
    dirty.current = false;
    const sb = supabase();
    const [{ data: r }, { data: its, error }] = await Promise.all([
      sb.from("rfqs").select("*").eq("id", id).single(),
      sb.from("rfq_items").select("*").eq("rfq_id", id).order("position"),
    ]);
    if (!r || error) {
      setListError(error?.message ?? "could not open RFQ");
      loading.current = false;
      return;
    }
    const rows = (its as RfqItemRow[]) ?? [];
    knownItemIds.current = rows.map((x) => x.id);
    setCurrentId(id);
    setSubject((r as RfqRow).subject);
    setItems(rows.length === 0 ? [{ ...BLANK }] : rows.map((it) => ({
      id: it.id,
      materialType: it.material_type ?? "",
      description: it.description ?? "",
      thicknessRaw: it.thickness_raw ?? "",
      heightRaw: it.height_raw ?? "",
      lengthRaw: it.length_raw ?? "",
      qty: it.qty == null ? "" : String(it.qty),
      itemRef: it.item_ref ?? "",
    })));
    setPreview(null);
    setSaveState("idle");
    setSaveError("");
    setTimeout(() => { loading.current = false; }, 0);
  }, [autosave]);

  function loadExample() {
    touch();
    setSubject(isMaterial ? SAMPLE_MATERIAL_SUBJECT : SAMPLE_GENERAL_SUBJECT);
    setItems(
      isMaterial
        ? SAMPLE_MATERIAL_ITEMS.map((s) => ({ ...BLANK, ...s }))
        : SAMPLE_GENERAL_ITEMS.map((s) => ({ ...BLANK, ...s }))
    );
    setPreview(null);
  }

  async function deleteRfq(id: string) {
    if (!confirm("Delete this RFQ? Supplier quotes against it are deleted too. This cannot be undone.")) return;
    const { error } = await supabase().from("rfqs").delete().eq("id", id);
    if (error) { setListError(error.message); return; }
    if (currentId === id) newRfq();
    loadList();
  }

  // ---------- suggestions ----------
  const suggestions = useMemo(
    () => (isMaterial ? items.map((it) => suggestSuppliers(it.materialType, groups)) : items.map(() => [])),
    [isMaterial, items, groups]
  );

  // ---------- email ----------
  function generate() {
    const em = isMaterial
      ? buildMaterialEmail(subject || "RFQ", items.map((it) => ({
          materialType: it.materialType,
          thicknessRaw: it.thicknessRaw,
          heightRaw: it.heightRaw,
          lengthRaw: it.lengthRaw,
          qty: parseQty(it.qty),
          itemRef: it.itemRef,
        })))
      : buildGeneralEmail(subject || "RFQ", items.map((it) => ({
          description: it.description,
          qty: parseQty(it.qty),
          itemRef: it.itemRef,
        })));
    setPreview(em);
    if (recipients.trim() === "") {
      const emails = [...new Set(suggestions.flat().map((s) => s.email).filter(Boolean))] as string[];
      setRecipients(emails.join(", "));
    }
  }

  async function copyBody() {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setListError("Could not copy — select the text below and copy manually.");
    }
  }

  function setItem(i: number, patch: Partial<ItemDraft>) {
    touch();
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  const toList = recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const gmailUrl = preview ? gmailComposeUrl(toList, preview.subject, preview.body) : "";
  const tooLong = preview ? mailUrlTooLong(gmailUrl) : false;

  return (
    <div className="grid md:grid-cols-[230px_1fr] gap-6">
      {/* Saved RFQs — below the editor on mobile so the form is reachable */}
      <aside className="order-2 md:order-1">
        <button onClick={newRfq} className="w-full btn-primary mb-3">+ New RFQ</button>
        {listError && <div className="text-sm text-red-700 mb-2" role="alert">{listError}</div>}
        <div className="space-y-1">
          {rfqs.map((r) => (
            <div
              key={r.id}
              className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
                r.id === currentId ? "bg-blue-100" : "hover:bg-gray-100"
              }`}
            >
              <button onClick={() => openRfq(r.id)} className="flex-1 min-w-0 text-left">
                <span className="block truncate font-medium">{r.subject || "(no subject)"}</span>
                <span className="block text-xs text-gray-400">
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </button>
              <button
                onClick={() => deleteRfq(r.id)}
                aria-label={`Delete RFQ ${r.subject || "(no subject)"}`}
                title="Delete RFQ"
                className="text-red-400 hover:text-red-600 px-2 py-1"
              >
                ✕
              </button>
            </div>
          ))}
          {rfqs.length === 0 && <div className="text-xs text-gray-400 px-2">No saved RFQs yet.</div>}
        </div>
      </aside>

      {/* Editor */}
      <section className="order-1 md:order-2 space-y-4 min-w-0">
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-56">
            <label htmlFor="rfq-subject" className="lbl">Subject</label>
            <input
              id="rfq-subject"
              value={subject}
              onChange={(e) => { touch(); setSubject(e.target.value); }}
              placeholder={isMaterial ? "e.g. RFQ SO26-08134" : "e.g. RFQ Carbide Tap Mill"}
              className="w-full fld"
            />
          </div>
          <SaveIndicator
            state={saveState}
            error={saveError}
            onRetry={() => persist(currentId, subject, items)}
          />
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <button onClick={loadExample} className="btn-ghost text-sm">📋 Load example</button>
          {currentId && (
            <Link href={`/compare/${kind}?rfq=${currentId}`} className="btn-ghost text-sm">
              Compare quotes →
            </Link>
          )}
        </div>

        {isMaterial && (
          <p className="text-xs text-gray-500">
            Notation: <b>(00.00)</b> = order size in mm · <b>0.00</b> = finishing size (max
            allowance +5mm) · <b>Ø</b> = diameter — all kept exactly as typed, through to the email.
          </p>
        )}

        {/* Items */}
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={it.id ?? `new-${i}`} className="card">
              <div className="flex gap-2 flex-wrap items-end">
                <span className="text-sm font-bold w-14 pb-2">Item {i + 1}</span>
                {isMaterial ? (
                  <>
                    <Field id={`m-${i}`} label="Material Type" w="w-32" value={it.materialType} onChange={(v) => setItem(i, { materialType: v })} placeholder="SS 304" />
                    <Field id={`t-${i}`} label="Thickness" w="w-24" value={it.thicknessRaw} onChange={(v) => setItem(i, { thicknessRaw: v })} placeholder="2.0 / Ø4.00" />
                    <Field id={`h-${i}`} label="Height" w="w-24" value={it.heightRaw} onChange={(v) => setItem(i, { heightRaw: v })} placeholder="3.0" />
                    <Field id={`l-${i}`} label="Length" w="w-24" value={it.lengthRaw} onChange={(v) => setItem(i, { lengthRaw: v })} placeholder="(9.50)" />
                  </>
                ) : (
                  <Field id={`d-${i}`} label="Description" w="flex-1 min-w-56" value={it.description} onChange={(v) => setItem(i, { description: v })} placeholder="Carbide Tap Mill 2.500mm X 3.30mm" />
                )}
                <Field id={`q-${i}`} label="Qty" w="w-16" value={it.qty} onChange={(v) => setItem(i, { qty: v })} placeholder="3" />
                <Field id={`r-${i}`} label="Ref" w="w-40" value={it.itemRef} onChange={(v) => setItem(i, { itemRef: v })} placeholder="SO26-08134 (1)" />
                <button
                  onClick={() => { touch(); setItems((prev) => prev.filter((_, j) => j !== i)); }}
                  disabled={items.length === 1}
                  aria-label={`Remove item ${i + 1}`}
                  title="Remove item"
                  className="text-red-400 hover:text-red-600 px-2 py-2 disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
              {it.qty.trim() !== "" && parseQty(it.qty) == null && (
                <div className="mt-1 text-xs text-amber-700">
                  Qty must be a positive number — this item can&apos;t be priced in the comparison.
                </div>
              )}
              {isMaterial && suggestions[i].length > 0 && (
                <div className="mt-2 flex gap-1 flex-wrap text-xs items-center">
                  <span className="text-gray-400">Suggested:</span>
                  {suggestions[i].map((s) => (
                    <button
                      key={s.name}
                      title={`${s.category} — matched "${s.matchedKeyword}"`}
                      onClick={() => {
                        if (!s.email) return;
                        setRecipients((prev) => {
                          const list = prev.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
                          if (list.includes(s.email as string)) return prev;
                          return [...list, s.email as string].join(", ");
                        });
                      }}
                      className="bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-1 hover:bg-blue-100"
                    >
                      {s.name}{s.email ? "" : " (no email)"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => { touch(); setItems((prev) => [...prev, { ...BLANK }]); }}
          className="btn-ghost text-sm"
        >
          + Add item
        </button>

        {/* Email */}
        <div className="flex gap-2 flex-wrap items-center border-t pt-4">
          <button onClick={generate} className="btn-primary">✉️ Generate RFQ email</button>
          {preview && (
            <>
              <button onClick={copyBody} className="btn-ghost text-sm">
                {copied ? "Copied ✓" : "📋 Copy"}
              </button>
              {!tooLong && (
                <>
                  <a href={gmailUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost text-sm">
                    ✉️ Open in Gmail
                  </a>
                  <a href={mailtoUrl(toList, preview.subject, preview.body)} className="btn-ghost text-sm">
                    📨 Mail app
                  </a>
                </>
              )}
            </>
          )}
        </div>
        {preview && tooLong && (
          <div className="flag">
            This RFQ is too long to pre-fill a mail window reliably (the item list would be
            truncated). Use <b>Copy</b> and paste it into your email instead.
          </div>
        )}
        {preview && (
          <div className="space-y-2">
            <div>
              <label htmlFor="rfq-to" className="lbl">To (from suggestions — edit freely)</label>
              <input
                id="rfq-to"
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                className="w-full fld text-sm"
                placeholder="supplier1@x.com, supplier2@y.com"
              />
            </div>
            <div>
              <label htmlFor="rfq-body" className="lbl">Subject: {preview.subject}</label>
              <textarea
                id="rfq-body"
                readOnly
                value={preview.body}
                rows={Math.min(26, preview.body.split("\n").length + 1)}
                className="w-full fld font-mono text-xs bg-gray-50"
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  id, label, value, onChange, placeholder, w,
}: {
  id: string; label: string; value: string;
  onChange: (v: string) => void; placeholder?: string; w?: string;
}) {
  return (
    <div className={w}>
      <label htmlFor={id} className="lbl">{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full fld text-sm"
      />
    </div>
  );
}

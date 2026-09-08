"use client";

/* Shared editor for Tab 1 (RFQ Material) and Tab 2 (RFQ General).
 *
 * Two blocks on one page, per the client's 3 Sep 2026 spec:
 *   Purchase Requisition (PR)  — the requester types items. No subject here.
 *   PR Review                  — an editable COPY the buyer corrects and titles.
 * "Send to PR Review" copies PR → Review. The RFQ email, the recipients and the
 * Compare tab all read the REVIEW copy only. No roles: anyone signed in does both.
 *
 * Both blocks persist through syncRows() with a `stage` column, so rfq_items.id
 * stays stable and the supplier quotes referencing review items survive edits.
 * See src/lib/persist.ts for why that matters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import type { RfqKind, RfqRow, RfqItemRow, RfqStage } from "@/lib/types";
import { useSupplierData } from "@/lib/useSupplierData";
import { suggestSuppliers } from "@/lib/supplierMatch";
import { parseQty } from "@/lib/num";
import { looksLikeRoundStock } from "@/lib/weight";
import { debounce, syncRows, type SaveState } from "@/lib/persist";
import SaveIndicator from "./SaveIndicator";
import {
  buildGeneralEmail, buildMaterialEmail, gmailComposeUrl, mailtoUrl,
  mailUrlTooLong, type BuiltEmail,
} from "@/lib/email";

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

function rowToDraft(it: RfqItemRow): ItemDraft {
  return {
    id: it.id,
    materialType: it.material_type ?? "",
    description: it.description ?? "",
    thicknessRaw: it.thickness_raw ?? "",
    heightRaw: it.height_raw ?? "",
    lengthRaw: it.length_raw ?? "",
    qty: it.qty == null ? "" : String(it.qty),
    itemRef: it.item_ref ?? "",
  };
}

function hasContent(it: ItemDraft): boolean {
  return !!(it.materialType || it.description || it.thicknessRaw || it.heightRaw ||
    it.lengthRaw || it.qty || it.itemRef);
}

/** Same array when no id was attached — a fresh array would refire autosave. */
function attachIds(ids: string[]) {
  return (prev: ItemDraft[]) => {
    let changed = false;
    const next = prev.map((it, i) => {
      if (it.id) return it;
      changed = true;
      return { ...it, id: ids[i] };
    });
    return changed ? next : prev;
  };
}

export default function RfqEditor({ kind }: { kind: RfqKind }) {
  const isMaterial = kind === "material";
  const { groups } = useSupplierData();

  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [stage, setStage] = useState<RfqStage>("pr");
  const [subject, setSubject] = useState("");
  const [prItems, setPrItems] = useState<ItemDraft[]>([{ ...BLANK }]);
  const [reviewItems, setReviewItems] = useState<ItemDraft[]>([]);
  const [recipients, setRecipients] = useState("");
  const [preview, setPreview] = useState<BuiltEmail | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [listError, setListError] = useState("");
  const [copied, setCopied] = useState(false);

  /** Server ids last seen per stage, for delete detection. */
  const knownPrIds = useRef<string[]>([]);
  const knownReviewIds = useRef<string[]>([]);
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
  const toRow = useCallback((it: ItemDraft, i: number, rfqId: string, st: RfqStage) => ({
    ...(it.id ? { id: it.id } : {}),
    rfq_id: rfqId,
    stage: st,
    position: i,
    material_type: isMaterial ? it.materialType : null,
    description: isMaterial ? null : it.description,
    thickness_raw: isMaterial ? it.thicknessRaw : null,
    height_raw: isMaterial ? it.heightRaw : null,
    length_raw: isMaterial ? it.lengthRaw : null,
    qty: parseQty(it.qty),
    item_ref: it.itemRef,
  }), [isMaterial]);

  const persist = useCallback(async (
    id: string | null, subj: string, st: RfqStage,
    pr: ItemDraft[], review: ItemDraft[], sentAt: string | null
  ): Promise<string | null> => {
    const sb = supabase();
    setSaveState("saving");
    let rfqId = id;

    const header = { subject: subj, stage: st, ...(sentAt ? { sent_to_review_at: sentAt } : {}) };
    if (rfqId) {
      const { error } = await sb.from("rfqs").update(header).eq("id", rfqId);
      if (error) { setSaveState("error"); setSaveError(error.message); return null; }
    } else {
      const { data: userData } = await sb.auth.getUser();
      const { data, error } = await sb.from("rfqs")
        .insert({ kind, ...header, created_by: userData.user?.email ?? "" })
        .select("id").single();
      if (error || !data) {
        setSaveState("error"); setSaveError(error?.message ?? "could not create RFQ");
        return null;
      }
      rfqId = data.id as string;
      setCurrentId(rfqId);
    }

    const prRes = await syncRows(sb, "rfq_items",
      pr.map((it, i) => toRow(it, i, rfqId as string, "pr")), knownPrIds.current);
    if (prRes.error) { setSaveState("error"); setSaveError(prRes.error.message); return null; }
    knownPrIds.current = prRes.ids;
    setPrItems(attachIds(prRes.ids));

    const rvRes = await syncRows(sb, "rfq_items",
      review.map((it, i) => toRow(it, i, rfqId as string, "review")), knownReviewIds.current);
    if (rvRes.error) { setSaveState("error"); setSaveError(rvRes.error.message); return null; }
    knownReviewIds.current = rvRes.ids;
    setReviewItems(attachIds(rvRes.ids));

    setSaveState("saved");
    setSaveError("");
    loadList();
    return rfqId;
  }, [kind, loadList, toRow]);

  /* The timer is created once and stays free of refs and state; every guard
   * lives in the effect below, which may read refs legitimately. */
  const autosave = useMemo(
    () => debounce((
      save: typeof persist, id: string | null, subj: string, st: RfqStage,
      pr: ItemDraft[], review: ItemDraft[]
    ) => save(id, subj, st, pr, review, null), 800),
    []
  );

  useEffect(() => {
    if (loading.current || !dirty.current) return;
    // Don't create an empty RFQ just because the page rendered.
    if (!currentId && subject.trim() === "" && !prItems.some(hasContent) && !reviewItems.some(hasContent)) return;
    // Cleared on scheduling: an edit during the debounce window sets it again
    // and reschedules, while a settled state never resaves — which would loop,
    // because a successful save updates the item arrays with their new ids.
    dirty.current = false;
    autosave(persist, currentId, subject, stage, prItems, reviewItems);
  }, [subject, stage, prItems, reviewItems, currentId, autosave, persist]);

  useEffect(() => () => autosave.cancel(), [autosave]);

  function touch() { dirty.current = true; }

  // ---------- loading / new ----------
  function resetEditor(next: {
    id: string | null; stage: RfqStage; subject: string;
    pr: ItemDraft[]; review: ItemDraft[];
  }) {
    loading.current = true;
    autosave.cancel();
    dirty.current = false;
    knownPrIds.current = next.pr.map((x) => x.id).filter((x): x is string => !!x);
    knownReviewIds.current = next.review.map((x) => x.id).filter((x): x is string => !!x);
    setCurrentId(next.id);
    setStage(next.stage);
    setSubject(next.subject);
    setPrItems(next.pr.length ? next.pr : [{ ...BLANK }]);
    setReviewItems(next.review);
    setPreview(null);
    setRecipients("");
    setSaveState("idle");
    setSaveError("");
    setTimeout(() => { loading.current = false; }, 0);
  }

  function newRfq() {
    resetEditor({ id: null, stage: "pr", subject: "", pr: [{ ...BLANK }], review: [] });
  }

  async function openRfq(id: string) {
    const sb = supabase();
    const [{ data: r }, { data: its, error }] = await Promise.all([
      sb.from("rfqs").select("*").eq("id", id).single(),
      sb.from("rfq_items").select("*").eq("rfq_id", id).order("position"),
    ]);
    if (!r || error) { setListError(error?.message ?? "could not open RFQ"); return; }
    const rows = (its as RfqItemRow[]) ?? [];
    const row = r as RfqRow;
    resetEditor({
      id,
      stage: row.stage ?? "review",
      subject: row.subject,
      pr: rows.filter((x) => x.stage === "pr").map(rowToDraft),
      review: rows.filter((x) => x.stage !== "pr").map(rowToDraft),
    });
  }

  /** Copy PR → Review. Existing review rows are reused by position so any
   *  supplier quotes already entered against them survive. */
  async function sendToReview(replace: boolean) {
    if (replace) {
      const extra = reviewItems.length > prItems.length ? reviewItems.length - prItems.length : 0;
      const msg = extra > 0
        ? `Replace the PR Review copy with the current PR? ${extra} extra review item(s) will be removed, together with any supplier quotes entered against them.`
        : "Replace the PR Review copy with the current PR? Supplier quotes on matching items are kept.";
      if (!confirm(msg)) return;
    }
    const copy = prItems.map((it, i) => ({
      ...it,
      id: reviewItems[i]?.id, // keep review ids by position; undefined → insert
    }));
    const subj = subject.trim() === "" ? todaySubject() : subject;
    const sentAt = new Date().toISOString();
    autosave.cancel();
    dirty.current = false;
    setStage("review");
    setSubject(subj);
    setReviewItems(copy);
    setPreview(null);
    await persist(currentId, subj, "review", prItems, copy, sentAt);
  }

  async function deleteRfq(id: string) {
    if (!confirm("Delete this RFQ? Supplier quotes against it are deleted too. This cannot be undone.")) return;
    const { error } = await supabase().from("rfqs").delete().eq("id", id);
    if (error) { setListError(error.message); return; }
    if (currentId === id) newRfq();
    loadList();
  }

  // ---------- suggestions ----------
  const prSuggestions = useMemo(
    () => (isMaterial ? prItems.map((it) => suggestSuppliers(it.materialType, groups)) : prItems.map(() => [])),
    [isMaterial, prItems, groups]
  );
  const reviewSuggestions = useMemo(
    () => (isMaterial ? reviewItems.map((it) => suggestSuppliers(it.materialType, groups)) : reviewItems.map(() => [])),
    [isMaterial, reviewItems, groups]
  );

  // ---------- email (from the REVIEW copy only) ----------
  function generate() {
    const em = isMaterial
      ? buildMaterialEmail(subject, reviewItems.map((it) => ({
          materialType: it.materialType,
          thicknessRaw: it.thicknessRaw,
          heightRaw: it.heightRaw,
          lengthRaw: it.lengthRaw,
          qty: parseQty(it.qty),
          itemRef: it.itemRef,
        })))
      : buildGeneralEmail(subject, reviewItems.map((it) => ({
          description: it.description,
          qty: parseQty(it.qty),
          itemRef: it.itemRef,
        })));
    setPreview(em);
    if (recipients.trim() === "") {
      const emails = [...new Set(reviewSuggestions.flat().map((s) => s.email).filter(Boolean))] as string[];
      setRecipients(emails.join(", "));
    }
  }

  async function copyBody() {
    if (!preview) return;
    try {
      // Copy variant has no signature — their Gmail auto-inserts one on paste.
      await navigator.clipboard.writeText(preview.bodyForCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setListError("Could not copy — select the text below and copy manually.");
    }
  }

  const addRecipient = (email: string | null) => {
    if (!email) return;
    setRecipients((prev) => {
      const list = prev.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      if (list.includes(email)) return prev;
      return [...list, email].join(", ");
    });
  };

  const toList = recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const gmailUrl = preview ? gmailComposeUrl(toList, preview.subject, preview.bodyForMail) : "";
  const tooLong = preview ? mailUrlTooLong(gmailUrl) : false;

  const reviewed = stage === "review";

  return (
    <div className="grid md:grid-cols-[230px_1fr] gap-6">
      {/* Saved RFQs — below the editor on mobile so the form is reachable */}
      <aside className="order-2 md:order-1">
        <button onClick={newRfq} className="w-full btn-primary mb-3">+ New Purchase Requisition</button>
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
                <span className="block truncate font-medium">{r.subject || "(PR — no subject yet)"}</span>
                <span className="block text-xs text-gray-400">
                  <StageBadge stage={r.stage ?? "review"} />{" "}
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </button>
              <button
                onClick={() => deleteRfq(r.id)}
                aria-label={`Delete ${r.subject || "purchase requisition"}`}
                title="Delete"
                className="text-red-400 hover:text-red-600 px-2 py-1"
              >
                ✕
              </button>
            </div>
          ))}
          {rfqs.length === 0 && <div className="text-xs text-gray-400 px-2">Nothing yet.</div>}
        </div>
      </aside>

      <section className="order-1 md:order-2 space-y-6 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <StageBadge stage={stage} large />
          <SaveIndicator
            state={saveState}
            error={saveError}
            onRetry={() => persist(currentId, subject, stage, prItems, reviewItems, null)}
          />
          {currentId && reviewed && (
            <Link href={`/compare/${kind}?rfq=${currentId}`} className="btn-ghost text-sm ml-auto">
              Compare quotes →
            </Link>
          )}
        </div>

        {/* ---------- Purchase Requisition ---------- */}
        <div className="space-y-3">
          <div>
            <h3 className="font-bold">Purchase Requisition (PR)</h3>
            <p className="hint">
              {reviewed
                ? "The original request. Edit the PR Review copy below; re-send only if the request itself changed."
                : "Type what is needed. The buyer adds the subject and corrects details in PR Review."}
            </p>
          </div>

          {isMaterial && !reviewed && (
            <p className="text-xs text-gray-500">
              Notation: <b>(00.00)</b> = order size in mm · <b>0.00</b> = finishing size (max
              allowance +5mm) · <b>Ø</b> = diameter — all kept exactly as typed, through to the email.
            </p>
          )}

          {reviewed ? (
            <ReadOnlyItems items={prItems} isMaterial={isMaterial} />
          ) : (
            <ItemEditor
              items={prItems} isMaterial={isMaterial} idPrefix="pr"
              suggestions={prSuggestions} onAddRecipient={addRecipient}
              onChange={(next) => { touch(); setPrItems(next); }}
            />
          )}

          <div className="flex gap-2 flex-wrap items-center">
            {!reviewed ? (
              <button
                onClick={() => sendToReview(false)}
                disabled={!prItems.some(hasContent)}
                className="btn-primary disabled:opacity-50"
              >
                Send to PR Review →
              </button>
            ) : (
              <button onClick={() => sendToReview(true)} className="btn-ghost text-sm">
                Re-send to PR Review (replaces the review copy)
              </button>
            )}
          </div>
        </div>

        {/* ---------- PR Review ---------- */}
        {reviewed && (
          <div className="space-y-3 border-t pt-5">
            <div>
              <h3 className="font-bold">PR Review</h3>
              <p className="hint">
                Correct anything here — this copy is what the RFQ email and the quote
                comparison use. The original PR above stays as typed.
              </p>
            </div>

            <div className="flex-1 min-w-56">
              <label htmlFor="rfq-subject" className="lbl">Subject</label>
              <input
                id="rfq-subject"
                value={subject}
                onChange={(e) => { touch(); setSubject(e.target.value); }}
                placeholder={isMaterial ? "e.g. RFQ SO26-08134" : "e.g. RFQ Carbide Tap Mill"}
                className="w-full fld"
              />
              <p className="hint mt-1">&quot;RFQ&quot; is added automatically if you leave it out.</p>
            </div>

            <ItemEditor
              items={reviewItems} isMaterial={isMaterial} idPrefix="rv"
              suggestions={reviewSuggestions} onAddRecipient={addRecipient}
              onChange={(next) => { touch(); setReviewItems(next); }}
            />

            {/* Email */}
            <div className="flex gap-2 flex-wrap items-center border-t pt-4">
              <button onClick={generate} disabled={reviewItems.length === 0} className="btn-primary disabled:opacity-50">
                ✉️ Generate RFQ email
              </button>
              {preview && (
                <>
                  <button onClick={copyBody} className="btn-ghost text-sm">
                    {copied ? "Copied ✓" : "📋 Copy"}
                  </button>
                  {!tooLong && (
                    <>
                      <a href={gmailUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost text-sm">
                        ✉️ Open in Gmail (BCC)
                      </a>
                      <a href={mailtoUrl(toList, preview.subject, preview.bodyForMail)} className="btn-ghost text-sm">
                        📨 Mail app (BCC)
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
                  <label htmlFor="rfq-to" className="lbl">
                    Recipients (from suggestions — edit freely) —{" "}
                    <span className="text-red-700 normal-case font-bold">⚠ must use BCC</span>
                  </label>
                  <input
                    id="rfq-to"
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                    className="w-full fld text-sm"
                    placeholder="supplier1@x.com, supplier2@y.com"
                  />
                  <p className="hint mt-1">
                    The Gmail / Mail app buttons put every address in <b>BCC</b> automatically,
                    so suppliers never see each other. If you paste manually, use the BCC field.
                  </p>
                </div>
                <div>
                  <label htmlFor="rfq-body" className="lbl">Subject: {preview.subject}</label>
                  <textarea
                    id="rfq-body"
                    readOnly
                    value={preview.bodyForMail}
                    rows={Math.min(26, preview.bodyForMail.split("\n").length + 1)}
                    className="w-full fld font-mono text-xs bg-gray-50"
                  />
                  <p className="hint mt-1">
                    <b>Copy</b> omits the signature block — your Gmail adds its own signature when
                    you paste into a new email. The Gmail / Mail app buttons include it.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function StageBadge({ stage, large }: { stage: RfqStage; large?: boolean }) {
  const cls = stage === "pr"
    ? "bg-amber-100 text-amber-800 border-amber-300"
    : "bg-green-100 text-green-800 border-green-300";
  return (
    <span className={`inline-block border rounded-full font-bold ${large ? "px-3 py-1 text-sm" : "px-1.5 py-0 text-[10px]"} ${cls}`}>
      {stage === "pr" ? "PR" : "Reviewed"}
    </span>
  );
}

function ReadOnlyItems({ items, isMaterial }: { items: ItemDraft[]; isMaterial: boolean }) {
  return (
    <div className="overflow-x-auto tbl-wrap">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col">#</th>
            {isMaterial ? (<>
              <th scope="col">Material Type</th><th scope="col">Thickness</th>
              <th scope="col">Height</th><th scope="col">Length</th>
            </>) : <th scope="col">Description</th>}
            <th scope="col">Qty</th><th scope="col">Ref</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id ?? i}>
              <td>Item {i + 1}</td>
              {isMaterial ? (<>
                <td>{it.materialType}</td><td>{it.thicknessRaw}</td>
                <td>{it.heightRaw}</td><td>{it.lengthRaw}</td>
              </>) : <td>{it.description}</td>}
              <td>{it.qty}</td><td>{it.itemRef}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemEditor({
  items, isMaterial, idPrefix, suggestions, onAddRecipient, onChange,
}: {
  items: ItemDraft[]; isMaterial: boolean; idPrefix: string;
  suggestions: ReturnType<typeof suggestSuppliers>[];
  onAddRecipient: (email: string | null) => void;
  onChange: (next: ItemDraft[]) => void;
}) {
  const setItem = (i: number, patch: Partial<ItemDraft>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={it.id ?? `new-${i}`} className="card">
            <div className="flex gap-2 flex-wrap items-end">
              <span className="text-sm font-bold w-14 pb-2">Item {i + 1}</span>
              {isMaterial ? (
                <>
                  <Field id={`${idPrefix}-m-${i}`} label="Material Type" w="w-32" value={it.materialType} onChange={(v) => setItem(i, { materialType: v })} placeholder="SS 304" />
                  <Field id={`${idPrefix}-t-${i}`} label="Thickness" w="w-24" value={it.thicknessRaw} onChange={(v) => setItem(i, { thicknessRaw: v })} placeholder="2.0 / Ø4.00" />
                  <Field id={`${idPrefix}-h-${i}`} label="Height" w="w-24" value={it.heightRaw} onChange={(v) => setItem(i, { heightRaw: v })} placeholder="3.0" />
                  <Field id={`${idPrefix}-l-${i}`} label="Length" w="w-24" value={it.lengthRaw} onChange={(v) => setItem(i, { lengthRaw: v })} placeholder="(9.50)" />
                </>
              ) : (
                <Field id={`${idPrefix}-d-${i}`} label="Description" w="flex-1 min-w-56" value={it.description} onChange={(v) => setItem(i, { description: v })} placeholder="Carbide Tap Mill 2.500mm X 3.30mm" />
              )}
              <Field id={`${idPrefix}-q-${i}`} label="Qty" w="w-16" value={it.qty} onChange={(v) => setItem(i, { qty: v })} placeholder="3" />
              <Field id={`${idPrefix}-r-${i}`} label="Ref" w="w-40" value={it.itemRef} onChange={(v) => setItem(i, { itemRef: v })} placeholder="SO26-08134 (1)" />
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
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
            {isMaterial &&
              looksLikeRoundStock(it.materialType, it.thicknessRaw, it.heightRaw, it.lengthRaw) && (
              <div className="mt-1 text-xs text-amber-700">
                Round bar? Mark the diameter with <b>Ø</b> (e.g. Ø127.00) and leave the
                other dimension blank — otherwise weight and RM/kg can&apos;t be computed.
              </div>
            )}
            {isMaterial && (suggestions[i]?.length ?? 0) > 0 && (
              <div className="mt-2 flex gap-1 flex-wrap text-xs items-center">
                <span className="text-gray-400">Suggested:</span>
                {suggestions[i].map((s) => (
                  <button
                    key={s.name}
                    title={`${s.category} — matched "${s.matchedKeyword}"`}
                    onClick={() => onAddRecipient(s.email)}
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
      <button onClick={() => onChange([...items, { ...BLANK }])} className="btn-ghost text-sm">
        + Add item
      </button>
    </>
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

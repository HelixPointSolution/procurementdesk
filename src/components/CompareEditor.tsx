"use client";

/* Tabs 3 & 4 — Quote Comparison (Material / General).
 *
 * Upload-first (client request, 25 Sep 2026): the purchaser drops in the 2–3
 * suppliers' quotations and the comparison appears. Each file is stored in the
 * private quotation-files bucket, read by Gemini (/api/extract-quote), and
 * turned into a supplier card. The typing grid still exists for checking and
 * correcting, but it sits collapsed under "Check / edit figures" instead of
 * being the whole page.
 *
 * 16 Oct 2026 (client's first real use): files are read ONE AT A TIME (in
 * parallel they tripped the AI's rate limit), a failed read can be retried
 * with "Read again", a screenshot can be pasted with Ctrl+V, a supplier's
 * message can be pasted as text, and the result ends with a per-item table —
 * cheapest and closest size, size first — with an optional split award.
 *
 * Unchanged underneath: suppliers may quote different dimensions than asked
 * (off-spec, flagged) or skip items; the tool recommends ("Claude's Choice")
 * but the purchaser decides; Award writes Purchase History. Edits persist
 * through syncRows(), never delete-and-reinsert.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { RfqKind, RfqRow, RfqItemRow, QuoteRow, QuoteItemRow, SupplierRow, QuoteAttachmentRow } from "@/lib/types";
import {
  analyseQuotes, byRmPerKg, perItemPicks, pickedOffer, splitPlan,
  type ComparisonResult, type ItemPicks, type SplitPlan, type SupplierAnalysis,
} from "@/lib/compare";
import { sizeFitText, type SizeFit } from "@/lib/dimensions";
import { parseQty, parsePrice } from "@/lib/num";
import { debounce, syncRows, type SaveState } from "@/lib/persist";
import {
  mapExtraction, nameFromFilename, uniqueSupplierName,
  type Extraction, type MappedLine,
} from "@/lib/extract";
import { prepareQuotationFile } from "@/lib/prepareUpload";
import SaveIndicator from "./SaveIndicator";

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
  attachments: QuoteAttachmentRow[];
  /** Things to double-check after automatic reading. Not persisted. */
  warnings: string[];
}

interface UploadJob {
  key: string;
  filename: string;
  status: "waiting" | "working" | "done" | "error";
  message: string;
}

/** Progress or problem shown on one supplier card (Read again / Add page). */
interface CardStatus {
  text: string;
  busy: boolean;
}

interface StoredFile {
  path: string;
  filename: string;
  mime: string;
  size: number;
}

const ATTACH_BUCKET = "quotation-files";
const ACCEPT = ".pdf,image/jpeg,image/png,image/webp";

const rm = (n: number) => "RM " + n.toFixed(2);

/** "item 2" / "items 1, 3, 4" from 0-based indexes. */
const itemList = (ks: number[]) => `item${ks.length > 1 ? "s" : ""} ${ks.map((k) => k + 1).join(", ")}`;

const timeStamp = () => new Date().toLocaleTimeString("en-GB").replace(/:/g, ".");

/** The supplier name a file gives when nothing better is known:
 *  "Quo 2026 (part 1 of 3).png" → "Quo 2026". */
function placeholderName(filename: string): string {
  return nameFromFilename(filename).replace(/ \(part \d+ of \d+\)$/, "");
}

/** Still named after its file (or unnamed), so a fresh reading may rename it. */
function hasPlaceholderName(name: string, atts: Array<{ filename: string }>): boolean {
  const bare = name.trim().replace(/ \(\d+\)$/, "");
  return bare === "" || atts.some((a) => bare === placeholderName(a.filename));
}

/** Browsers name every pasted picture "image.png" — give it a name a purchaser can tell apart. */
function namePasted(f: File, n: number, all: File[]): File {
  if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([f], `Pasted picture ${timeStamp()}${all.length > 1 ? `-${n + 1}` : ""}.${ext}`, { type: f.type });
}

function extractionItems(its: RfqItemRow[]) {
  return its.map((it) => ({
    materialType: it.material_type ?? "",
    description: it.description ?? "",
    thicknessRaw: it.thickness_raw ?? "",
    heightRaw: it.height_raw ?? "",
    lengthRaw: it.length_raw ?? "",
    qty: it.qty,
    itemRef: it.item_ref ?? "",
  }));
}

/** Prepare (shrink, cut long screenshots into pages) and store files under an RFQ. */
async function storeFiles(
  rid: string, originals: File[], progress: (message: string) => void
): Promise<{ ok: true; files: StoredFile[] } | { ok: false; error: string }> {
  const prepared: File[] = [];
  for (const f of originals) {
    const p = await prepareQuotationFile(f);
    if (!p.ok) return { ok: false, error: p.error };
    prepared.push(...p.files);
  }
  progress(prepared.length > 1 ? `Uploading ${prepared.length} pages…` : "Uploading…");
  const sb = supabase();
  const files: StoredFile[] = [];
  for (const file of prepared) {
    const safe = file.name.replace(/[^\w.\-() ]+/g, "_");
    const path = `${rid}/${crypto.randomUUID()}-${safe}`;
    const contentType = file.type.startsWith("text/plain") ? "text/plain;charset=utf-8" : file.type || undefined;
    const up = await sb.storage.from(ATTACH_BUCKET).upload(path, file, { contentType });
    if (up.error) {
      if (files.length > 0) await sb.storage.from(ATTACH_BUCKET).remove(files.map((x) => x.path));
      return { ok: false, error: "Upload failed: " + up.error.message };
    }
    files.push({ path, filename: file.name, mime: file.type, size: file.size });
  }
  return { ok: true, files };
}

/** Ask the server to read stored files as ONE supplier's quotation. */
async function readStored(rid: string, paths: string[]): Promise<{ extraction: Extraction | null; problem: string }> {
  try {
    const { data: sess } = await supabase().auth.getSession();
    const res = await fetch("/api/extract-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session?.access_token ?? ""}` },
      body: JSON.stringify({ rfqId: rid, paths }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.extraction) return { extraction: body.extraction as Extraction, problem: "" };
    if (body.error === "not_configured") {
      return { extraction: null, problem: "Automatic reading is not switched on yet — type the prices under “Check / edit figures”." };
    }
    return { extraction: null, problem: (body.error as string) || `Could not read the quotation (${res.status}) — press “Read again”.` };
  } catch {
    return { extraction: null, problem: "Could not reach the reader — check the internet connection, then press “Read again”." };
  }
}

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
  const [rfqStage, setRfqStage] = useState<"pr" | "review">("review");
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [choice, setChoice] = useState("");
  const [awardMsg, setAwardMsg] = useState("");
  const [awarding, setAwarding] = useState(false);
  const [splitMsg, setSplitMsg] = useState("");
  /** Per-item supplier picks the purchaser changed, by RFQ item id. */
  const [picks, setPicks] = useState<Record<string, string>>({});
  /** By quote id. */
  const [cardStatus, setCardStatusMap] = useState<Record<string, CardStatus>>({});
  const [pasteText, setPasteText] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteHint, setPasteHint] = useState("");

  const knownQuoteIds = useRef<string[]>([]);
  const loading = useRef(false);
  const dirty = useRef(false);
  /** Supplier names claimed by uploads still in flight, so two parallel
   *  uploads from the same company get distinct names. */
  const reservedNames = useRef<Set<string>>(new Set());
  /** Latest quotes for code running across awaits (processFile). */
  const quotesRef = useRef<QuoteDraft[]>([]);
  useEffect(() => { quotesRef.current = quotes; }, [quotes]);
  /** Quotations are read one after another, never in parallel: parallel
   *  calls tripped the AI's rate limit on the client's first real use. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  function enqueue(run: () => Promise<void>) {
    queue.current = queue.current.then(run).catch((e) => { console.error(e); });
  }
  function setCardStatus(id: string, status: CardStatus | null) {
    setCardStatusMap((prev) => {
      const next = { ...prev };
      if (status) next[id] = status; else delete next[id];
      return next;
    });
  }

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
    setSplitMsg("");
    setChoice("");
    setPicks({});
    setCardStatusMap({});
    setSaveState("idle");
    setJobs([]);
    if (!id) { setItems([]); setQuotes([]); loading.current = false; return; }

    const sb = supabase();
    // Compare works on the PR REVIEW copy only — the buyer-corrected items.
    const [{ data: hdr }, { data: its, error: e1 }, { data: qs, error: e2 }] = await Promise.all([
      sb.from("rfqs").select("stage").eq("id", id).single(),
      sb.from("rfq_items").select("*").eq("rfq_id", id).eq("stage", "review").order("position"),
      sb.from("quotes").select("*, quote_items(*), quote_attachments(*)").eq("rfq_id", id).order("created_at"),
    ]);
    if (e1 || e2) {
      setPageError(e1?.message ?? e2?.message ?? "could not load");
      loading.current = false;
      return;
    }
    setRfqStage(((hdr as { stage?: "pr" | "review" } | null)?.stage) ?? "review");
    const rfqItems = (its as RfqItemRow[]) ?? [];
    setItems(rfqItems);
    type QuoteWithItems = QuoteRow & { quote_items: QuoteItemRow[]; quote_attachments?: QuoteAttachmentRow[] };
    const loaded = ((qs ?? []) as QuoteWithItems[]).map((q) => ({
      id: q.id,
      supplierName: q.supplier_name,
      notes: q.notes,
      warnings: [],
      attachments: (q.quote_attachments ?? []).slice().sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at)),
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

  /* Sizes start EMPTY, never copied from the RFQ (client, 25 Sep): suppliers
   * often change sizes, and a pre-filled size hides that. The inquiry size
   * still shows as the grey placeholder for reference. A blank qty is priced
   * at the inquiry qty by the comparison engine. */
  function blankQuoteItem(_it: RfqItemRow, quoted: boolean): QuoteItemDraft {
    return { quoted, thicknessRaw: "", heightRaw: "", lengthRaw: "", qty: "", price: "", notes: "" };
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

  // ---------- upload → read → supplier card ----------
  const setJob = (key: string, patch: Partial<UploadJob>) =>
    setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  /** One supplier's quotation (a file, a pasted picture or pasted text), end
   *  to end. Writes the quote straight to the database (header, lines,
   *  attachments) and only then adds the finished card to state, so a
   *  half-read file never shows up as a card. */
  async function processSubmission(key: string, rid: string, its: RfqItemRow[], original: File, nameHint?: string) {
    setJob(key, { status: "working", message: "Preparing…" });
    const sb = supabase();
    const stored = await storeFiles(rid, [original], (message) => setJob(key, { message }));
    if (!stored.ok) { setJob(key, { status: "error", message: stored.error }); return; }
    const paths = stored.files.map((f) => f.path);

    setJob(key, { message: "Reading the quotation… (usually under a minute)" });
    const { extraction, problem } = await readStored(rid, paths);

    const fallbackName = nameHint?.trim() || nameFromFilename(original.name);
    const mapped = extraction
      ? mapExtraction(extraction, extractionItems(its), fallbackName)
      : {
          supplierName: fallbackName, notes: "", warnings: [problem],
          lines: its.map((it): MappedLine => ({ ...blankQuoteItem(it, false) })),
        };
    // A name the purchaser typed for pasted text wins over whatever the text says.
    const taken = [...quotesRef.current.map((q) => q.supplierName), ...reservedNames.current];
    const supplierName = uniqueSupplierName(nameHint?.trim() || mapped.supplierName, taken);
    reservedNames.current.add(supplierName);

    setJob(key, { message: "Saving…" });
    let quoteId = "";
    try {
      const { data: userData } = await sb.auth.getUser();
      const who = userData.user?.email ?? "";
      const { data: qrow, error: qErr } = await sb.from("quotes").insert({
        rfq_id: rid,
        supplier_name: supplierName,
        supplier_id: suppliers.find((s) => s.name.toLowerCase() === supplierName.toLowerCase())?.id ?? null,
        notes: mapped.notes,
      }).select("id").single();
      if (qErr || !qrow) throw new Error(qErr?.message ?? "could not save the supplier");
      quoteId = qrow.id as string;

      const lineRows = mapped.lines
        .map((l, k) => ({ l, it: its[k] }))
        .filter(({ l, it }) => l.quoted && !!it)
        .map(({ l, it }) => ({
          quote_id: quoteId,
          rfq_item_id: it.id,
          thickness_raw: isMaterial ? l.thicknessRaw : null,
          height_raw: isMaterial ? l.heightRaw : null,
          length_raw: isMaterial ? l.lengthRaw : null,
          qty: parseQty(l.qty),
          price: parsePrice(l.price),
          notes: l.notes,
        }));
      const idByItem = new Map<string, string>();
      if (lineRows.length > 0) {
        const { data: inserted, error: liErr } = await sb.from("quote_items").insert(lineRows).select("id, rfq_item_id");
        if (liErr) throw new Error(liErr.message);
        for (const r of (inserted ?? []) as Array<{ id: string; rfq_item_id: string }>) idByItem.set(r.rfq_item_id, r.id);
      }

      const { data: atts, error: attErr } = await sb.from("quote_attachments").insert(
        stored.files.map((f) => ({
          quote_id: quoteId, path: f.path, filename: f.filename, mime: f.mime, size: f.size, uploaded_by: who,
        }))
      ).select("*");
      if (attErr || !atts) throw new Error(attErr?.message ?? "could not record the file");

      const card: QuoteDraft = {
        id: quoteId,
        supplierName,
        notes: mapped.notes,
        warnings: mapped.warnings,
        attachments: atts as QuoteAttachmentRow[],
        knownItemIds: [...idByItem.values()],
        items: its.map((it, k) => ({ ...mapped.lines[k], id: idByItem.get(it.id) })),
      };
      knownQuoteIds.current = [...knownQuoteIds.current, quoteId];
      // The next queued file starts before React re-renders; let it see this name.
      quotesRef.current = [...quotesRef.current, card];
      // Appended without touch(): it is already saved, so no autosave is needed.
      setQuotes((prev) => [...prev, card]);
      setJob(key, {
        status: "done",
        message: extraction
          ? `Read as ${supplierName}${mapped.warnings.length ? " — please check the flagged points" : ""}`
          : `Added as ${supplierName} — ${problem}`,
      });
    } catch (e) {
      if (quoteId) await sb.from("quotes").delete().eq("id", quoteId);
      await sb.storage.from(ATTACH_BUCKET).remove(paths);
      setJob(key, { status: "error", message: "Could not save: " + (e instanceof Error ? e.message : "unknown error") });
    } finally {
      reservedNames.current.delete(supplierName);
    }
  }

  /** Read a saved card's files again — after a busy or failed read, or after
   *  a page was added — and replace its figures with the fresh reading. */
  async function rereadCard(id: string, rid: string, its: RfqItemRow[], atts: Array<{ path: string; filename: string }>) {
    if (atts.length === 0) { setCardStatus(id, null); return; }
    setCardStatus(id, { text: "Reading the quotation… (usually under a minute)", busy: true });
    const { extraction, problem } = await readStored(rid, atts.map((a) => a.path));
    if (!extraction) {
      setCardStatus(id, null);
      // Warnings are not persisted, so no touch().
      setQuotes((prev) => prev.map((q) => (q.id === id ? { ...q, warnings: [problem] } : q)));
      return;
    }
    const mapped = mapExtraction(extraction, extractionItems(its), placeholderName(atts[0].filename));
    touch();
    setQuotes((prev) => prev.map((q) => {
      if (q.id !== id) return q;
      // Replace a file-name placeholder with the company the reader found;
      // keep a name the purchaser chose.
      const rename = hasPlaceholderName(q.supplierName, atts) && extraction.supplier_name.trim() !== "";
      const others = prev.filter((x) => x !== q).map((x) => x.supplierName);
      return {
        ...q,
        supplierName: rename ? uniqueSupplierName(mapped.supplierName, others) : q.supplierName,
        notes: mapped.notes,
        warnings: mapped.warnings,
        // Lines still quoted keep their row id; a line no longer quoted drops
        // it, so its row is deleted on save rather than updated in place.
        items: its.map((_, k) => ({ ...mapped.lines[k], id: mapped.lines[k].quoted ? q.items[k]?.id : undefined })),
      };
    }));
    setCardStatus(id, null);
  }

  /** More pages (or a first file) for a saved supplier, then read it all again. */
  async function addPages(id: string, rid: string, its: RfqItemRow[], files: File[]) {
    const q = quotesRef.current.find((x) => x.id === id);
    if (!q) { setCardStatus(id, null); return; }
    setCardStatus(id, { text: "Preparing…", busy: true });
    const stored = await storeFiles(rid, files, (text) => setCardStatus(id, { text, busy: true }));
    if (!stored.ok) { setCardStatus(id, { text: stored.error, busy: false }); return; }
    const sb = supabase();
    const { data: userData } = await sb.auth.getUser();
    const { data: rows, error } = await sb.from("quote_attachments").insert(
      stored.files.map((f) => ({
        quote_id: id, path: f.path, filename: f.filename, mime: f.mime, size: f.size,
        uploaded_by: userData.user?.email ?? "",
      }))
    ).select("*");
    if (error || !rows) {
      await sb.storage.from(ATTACH_BUCKET).remove(stored.files.map((f) => f.path));
      setCardStatus(id, { text: "Could not save: " + (error?.message ?? "unknown error"), busy: false });
      return;
    }
    const added = rows as QuoteAttachmentRow[];
    setQuotes((prev) => prev.map((x) => (x.id === id ? { ...x, attachments: [...x.attachments, ...added] } : x)));
    await rereadCard(id, rid, its, [...q.attachments, ...added]);
  }

  function handleFiles(list: FileList | File[] | null, nameHint?: string) {
    if (!list || !rfqId || rfqStage === "pr") return;
    const rid = rfqId;
    const its = items;
    for (const f of Array.from(list)) {
      const key = crypto.randomUUID();
      setJobs((prev) => [...prev, { key, filename: f.name, status: "waiting", message: "Waiting — quotations are read one at a time…" }]);
      enqueue(() => processSubmission(key, rid, its, f, nameHint));
    }
  }

  function requestReread(i: number) {
    const q = quotes[i];
    if (!q.id || q.attachments.length === 0) return;
    if (q.items.some((qi) => qi.quoted) &&
        !confirm("Read again replaces this supplier's figures with a fresh reading of its file(s). Continue?")) return;
    const id = q.id, rid = rfqId, its = items;
    setCardStatus(id, { text: "Waiting — quotations are read one at a time…", busy: true });
    enqueue(() => rereadCard(id, rid, its, quotesRef.current.find((x) => x.id === id)?.attachments ?? []));
  }

  function requestAddPages(i: number, list: FileList | null) {
    const q = quotes[i];
    if (!list || list.length === 0 || !q.id) return;
    if (q.items.some((qi) => qi.quoted) &&
        !confirm("Adding a page reads the whole quotation again and replaces this supplier's figures. Continue?")) return;
    const id = q.id, rid = rfqId, its = items, files = Array.from(list);
    setCardStatus(id, { text: "Waiting — quotations are read one at a time…", busy: true });
    enqueue(() => addPages(id, rid, its, files));
  }

  // ---------- paste: pictures and text (client, 16 Oct) ----------
  async function pasteFromClipboard() {
    setPasteHint("");
    if (!navigator.clipboard?.read) {
      setPasteHint("This browser can't paste from a button — press Ctrl+V instead.");
      return;
    }
    try {
      const entries = await navigator.clipboard.read();
      const files: File[] = [];
      let text = "";
      for (const entry of entries) {
        const pic = entry.types.find((t) => t.startsWith("image/"));
        if (pic) {
          files.push(new File([await entry.getType(pic)], `image.${pic.split("/")[1]}`, { type: pic }));
        } else if (entry.types.includes("text/plain")) {
          text += await (await entry.getType("text/plain")).text();
        }
      }
      if (files.length > 0) handleFiles(files.map(namePasted));
      else if (text.trim()) { setPasteText(text); setPasteOpen(true); }
      else setPasteHint("Nothing to paste — copy a screenshot or the supplier's message first.");
    } catch {
      setPasteHint("The browser blocked the clipboard — press Ctrl+V instead.");
    }
  }

  function readPastedText() {
    const text = pasteText.trim();
    if (!text) return;
    const name = pasteName.trim();
    const safeName = name.replace(/[^\w\-() ]+/g, " ").trim();
    handleFiles([new File([text], `${safeName || "Pasted text"} ${timeStamp()}.txt`, { type: "text/plain" })], name || undefined);
    setPasteText("");
    setPasteName("");
    setPasteOpen(false);
  }

  // ---------- manual editing ----------
  function addQuote() {
    touch();
    setQuotes((prev) => [...prev, {
      supplierName: "", notes: "", knownItemIds: [], attachments: [], warnings: [],
      items: items.map((it) => blankQuoteItem(it, true)),
    }]);
  }
  function setQuote(i: number, patch: Partial<QuoteDraft>) {
    touch();
    setQuotes((prev) => prev.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  }
  function setQuoteItem(i: number, k: number, patch: Partial<QuoteItemDraft>) {
    touch();
    // An unticked line's row is deleted on save. Drop its id, or ticking it
    // again would "update" a row that no longer exists and lose the line.
    const p = patch.quoted === false ? { ...patch, id: undefined } : patch;
    setQuotes((prev) => prev.map((q, j) =>
      j === i ? { ...q, items: q.items.map((qi, l) => (l === k ? { ...qi, ...p } : qi)) } : q
    ));
  }
  async function removeQuote(i: number) {
    const q = quotes[i];
    if (q.id && !confirm(`Remove ${q.supplierName || "this supplier"}'s quote?`)) return;
    touch();
    setQuotes((prev) => prev.filter((_, j) => j !== i));
    // The attachment rows cascade with the quote; the stored files do not.
    if (q.attachments.length > 0) {
      await supabase().storage.from(ATTACH_BUCKET).remove(q.attachments.map((a) => a.path));
    }
  }

  async function openAttachment(a: QuoteAttachmentRow) {
    const { data, error } = await supabase().storage.from(ATTACH_BUCKET).createSignedUrl(a.path, 3600);
    if (error || !data) { setPageError("Could not open file: " + (error?.message ?? "unknown")); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  // ---------- analysis (always live) ----------
  const inquiry = useMemo(() => items.map((it) => ({
    id: it.id,
    materialType: it.material_type ?? "",
    thicknessRaw: it.thickness_raw ?? "",
    heightRaw: it.height_raw ?? "",
    lengthRaw: it.length_raw ?? "",
    qty: it.qty,
    itemRef: it.item_ref ?? "",
  })), [items]);

  const result: ComparisonResult | null = useMemo(() => {
    if (inquiry.length === 0) return null;
    return analyseQuotes(
      inquiry,
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
  }, [inquiry, items, quotes]);

  // Per item: material picks by size first (client, 16 Oct); general by price.
  const itemPicks = useMemo(
    () => (result ? perItemPicks(result, inquiry, isMaterial) : []),
    [result, inquiry, isMaterial]
  );
  const plan = useMemo(() => splitPlan(itemPicks, picks), [itemPicks, picks]);

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

  /** Option A — one Purchase History row per supplier, for the items picked from it. */
  async function awardSplit() {
    if (awarding || plan.bySupplier.length === 0) return;
    setAwarding(true);
    const ref = rfqs.find((r) => r.id === rfqId)?.subject ?? "";
    const { data: userData } = await supabase().auth.getUser();
    const rows = plan.bySupplier.map((g) => ({
      rfq_id: rfqId,
      ref,
      awarded_to: g.supplierName,
      total_rm: Math.round(g.subtotal * 100) / 100,
      notes: [
        `Split award — ${itemList(g.items)}`,
        result?.suppliers.find((s) => s.supplierName === g.supplierName)?.notes ?? "",
      ].filter(Boolean).join(" · "),
      created_by: userData.user?.email ?? "",
    }));
    const { error } = await supabase().from("purchase_history").insert(rows);
    setAwarding(false);
    if (error) { setPageError(error.message); return; }
    setSplitMsg(rows.length === 1
      ? `Awarded to ${rows[0].awarded_to} — recorded in Purchase History ✓`
      : `Recorded in Purchase History — one row per supplier (${rows.length}) ✓`);
  }

  const rfq = rfqs.find((r) => r.id === rfqId);
  const ready = !!rfqId && rfqStage !== "pr" && items.length > 0;
  const working =
    jobs.some((j) => j.status === "waiting" || j.status === "working") ||
    Object.values(cardStatus).some((c) => c.busy);

  // Ctrl+V anywhere on the page (outside a field) adds a copied screenshot or
  // file as a supplier quotation, or opens the paste-text box with copied text.
  const handleFilesRef = useRef(handleFiles);
  useEffect(() => { handleFilesRef.current = handleFiles; });
  useEffect(() => {
    if (!ready) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        handleFilesRef.current(files.map(namePasted));
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim()) {
        e.preventDefault();
        setPasteText(text);
        setPasteOpen(true);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [ready]);
  const analysisFor = (name: string) => result?.suppliers.find((s) => s.supplierName === name.trim());

  return (
    <div className="space-y-5">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label htmlFor="cmp-rfq" className="lbl">RFQ</label>
          <select
            id="cmp-rfq"
            value={rfqId}
            onChange={(e) => loadRfq(e.target.value)}
            disabled={working}
            title={working ? "Wait until the quotations have been read" : undefined}
            className="fld min-w-56 disabled:opacity-60"
          >
            {rfqs.length === 0 && <option value="">No RFQs yet</option>}
            {rfqs.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.stage ?? "review") === "pr" ? "[PR] " : ""}{r.subject || "(no subject)"} — {new Date(r.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </div>
        {rfqId && <SaveIndicator state={saveState} error={saveError} onRetry={() => persist(rfqId, quotes)} />}
      </div>

      {pageError && <div className="flag" role="alert">{pageError}</div>}
      {rfqId && rfqStage === "pr" && (
        <div className="flag">
          This request is still a <b>Purchase Requisition</b> — it has not been sent to PR
          Review yet, so there is nothing to compare. Open it on the RFQ tab and press
          <b> Send to PR Review</b>.
        </div>
      )}
      {rfqId && rfqStage !== "pr" && items.length === 0 && (
        <div className="text-sm text-gray-500">This RFQ has no reviewed items yet.</div>
      )}

      {/* ---------- Step 1: upload ---------- */}
      {ready && (
        <div>
          <div className="chart-title">1. Upload the suppliers&apos; quotations</div>
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
            className={`block cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
              dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-white hover:bg-gray-50"
            }`}
          >
            <div className="text-3xl" aria-hidden>📄</div>
            <div className="font-semibold mt-1">Drop quotations here, or click to choose</div>
            <div className="hint mt-1">
              One file per supplier — PDF, photo or screenshot (long screenshots are fine). Select 2 or 3
              at once. The prices are read automatically; check them before awarding.
            </div>
            <input
              type="file" multiple accept={ACCEPT}
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
            />
          </label>

          <div className="flex gap-3 items-center flex-wrap mt-2">
            <button onClick={pasteFromClipboard} className="btn-ghost text-sm">📋 Paste screenshot</button>
            <span className="hint">or copy a screenshot and press Ctrl+V anywhere on this page</span>
            {pasteHint && <span className="text-sm text-amber-700">{pasteHint}</span>}
          </div>

          <details
            open={pasteOpen}
            onToggle={(e) => setPasteOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="mt-2"
          >
            <summary className="text-sm text-blue-700 cursor-pointer select-none">
              ✍ Prices came in a WhatsApp or email message? Paste the text
            </summary>
            <div className="mt-2 space-y-2">
              <textarea
                aria-label="Supplier's message"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={6}
                placeholder="Paste one supplier's message here — items, sizes and prices."
                className="w-full fld text-sm"
              />
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label htmlFor="paste-name" className="lbl">Supplier (optional)</label>
                  <input
                    id="paste-name"
                    value={pasteName}
                    onChange={(e) => setPasteName(e.target.value)}
                    list="supplier-names"
                    placeholder="Supplier name"
                    className="fld text-sm min-w-48"
                  />
                </div>
                <button onClick={readPastedText} disabled={!pasteText.trim()} className="btn-primary disabled:opacity-50">
                  Read this text
                </button>
              </div>
            </div>
          </details>

          {jobs.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm" aria-live="polite">
              {jobs.map((j) => (
                <li key={j.key} className="flex gap-2 items-start">
                  <span aria-hidden>
                    {j.status === "waiting" ? "🕒" : j.status === "working" ? "⏳" : j.status === "done" ? "✅" : "⚠️"}
                  </span>
                  <span>
                    <b>{j.filename}</b> — <span className={j.status === "error" ? "text-red-700" : "text-gray-600"}>{j.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---------- Step 2: suppliers ---------- */}
      {ready && quotes.length > 0 && (
        <div className="space-y-2">
          <div className="chart-title">2. Suppliers</div>
          {quotes.map((q, i) => {
            const a = analysisFor(q.supplierName);
            const st = q.id ? cardStatus[q.id] : undefined;
            const cardBusy = !!st?.busy;
            return (
              <div key={q.id ?? `new-${i}`} className="card space-y-2">
                <div className="flex gap-3 items-center flex-wrap">
                  <input
                    aria-label={`Supplier ${i + 1} name`}
                    value={q.supplierName}
                    onChange={(e) => setQuote(i, { supplierName: e.target.value })}
                    list="supplier-names"
                    placeholder="Supplier name"
                    className="fld text-sm font-semibold flex-1 min-w-48"
                  />
                  <span className="text-sm">
                    {a && a.pricedCount > 0
                      ? <><b>{rm(a.total)}</b> <span className="text-gray-500">· {a.quotedCount}/{items.length} items</span></>
                      : <span className="text-gray-500">no prices yet</span>}
                  </span>
                  {q.attachments.map((f) => (
                    <button key={f.id} onClick={() => openAttachment(f)} className="text-xs text-blue-700 underline" title="Open the quotation">
                      📎 {f.filename}
                    </button>
                  ))}
                  {q.id && q.attachments.length > 0 && (
                    <button
                      onClick={() => requestReread(i)}
                      disabled={cardBusy}
                      className="text-xs text-blue-700 underline disabled:opacity-50"
                      title="Read this supplier's file(s) again"
                    >
                      ↻ Read again
                    </button>
                  )}
                  {q.id && (
                    <label
                      className={`text-xs text-blue-700 underline cursor-pointer ${cardBusy ? "opacity-50 pointer-events-none" : ""}`}
                      title="Another page or screenshot of this supplier's quotation"
                    >
                      {q.attachments.length > 0 ? "+ Add page" : "+ Attach quotation"}
                      <input
                        type="file" multiple accept={ACCEPT} className="hidden" disabled={cardBusy}
                        onChange={(e) => { requestAddPages(i, e.target.files); e.target.value = ""; }}
                      />
                    </label>
                  )}
                  <button
                    onClick={() => removeQuote(i)}
                    aria-label={`Remove ${q.supplierName || "supplier"}`}
                    className="text-red-400 hover:text-red-600 px-2 py-1 ml-auto"
                  >
                    ✕
                  </button>
                </div>

                {q.supplierName.trim() === "" && (
                  <div className="text-xs text-amber-700">Give this supplier a name — unnamed quotes are not saved.</div>
                )}
                {st && (
                  <div className={`text-sm ${st.busy ? "text-gray-600" : "text-red-700"}`} aria-live="polite">
                    {st.busy ? "⏳" : "⚠"} {st.text}
                  </div>
                )}
                {q.warnings.length > 0 && !cardBusy && (
                  <div className="flag mt-0">{q.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>
                )}
                {q.notes && <div className="text-xs text-gray-600">{q.notes}</div>}

                <details>
                  <summary className="text-sm text-blue-700 cursor-pointer select-none">Check / edit figures</summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <label htmlFor={`note-${i}`} className="lbl">Supplier notes</label>
                      <input
                        id={`note-${i}`}
                        value={q.notes}
                        onChange={(e) => setQuote(i, { notes: e.target.value })}
                        placeholder="e.g. Ex-stock, valid till tomorrow"
                        className="w-full fld text-sm"
                      />
                    </div>
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
                                <TdInput label={`${label} quantity`} value={qi.qty} disabled={!qi.quoted} inquiry={it.qty == null ? null : String(it.qty)} onChange={(v) => setQuoteItem(i, k, { qty: v })} />
                                <TdInput label={`${label} price`} value={qi.price} disabled={!qi.quoted} invalid={qi.quoted && qi.price.trim() !== "" && parsePrice(qi.price) == null} onChange={(v) => setQuoteItem(i, k, { price: v })} />
                                <TdInput label={`${label} notes`} value={qi.notes} disabled={!qi.quoted} onChange={(v) => setQuoteItem(i, k, { notes: v })} placeholder="e.g. Quoted 3mm" />
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      )}
      {ready && (
        <button onClick={addQuote} disabled={working} className="text-sm text-blue-700 underline disabled:opacity-50">
          + Add a supplier by typing instead
        </button>
      )}
      <datalist id="supplier-names">
        {suppliers.map((s) => <option key={s.id} value={s.name} />)}
      </datalist>

      {/* ---------- Step 3: result ---------- */}
      {ready && result && result.suppliers.length > 0 && (
        <div className="space-y-4 pt-1">
          <div className="chart-title">3. Result</div>
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

          <Chart1 result={result} items={items} isMaterial={isMaterial} choice={choice} />

          <PerItem
            picks={itemPicks}
            overrides={picks}
            onPick={(itemId, name) => { setPicks((prev) => ({ ...prev, [itemId]: name })); setSplitMsg(""); }}
            plan={plan}
            result={result}
            items={items}
            isMaterial={isMaterial}
            awarding={awarding}
            onAward={awardSplit}
            message={splitMsg}
          />

          {isMaterial && (
            <details>
              <summary className="text-sm text-blue-700 cursor-pointer select-none">
                More detail — price per kg and size match
              </summary>
              <div className="space-y-6 mt-3">
                <Chart2 result={result} />
                <Chart3 result={result} items={items} />
              </div>
            </details>
          )}
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
      <div className="chart-title">Side by side — as quoted</div>
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
      <div className="chart-title">Normalised RM/kg (the fair ruler)</div>
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
      <div className="chart-title">Closest to what we asked (size match)</div>
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
                  if (a.fit && a.fit.kind !== "exact") missing.push(sizeFitText(a.fit));
                  if (!a.qtyOk) missing.push("qty differs");
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

function FitBadge({ fit }: { fit: SizeFit }) {
  const tone = {
    exact: "bg-green-100 text-green-800",
    bigger: "bg-amber-100 text-amber-800",
    unknown: "bg-gray-100 text-gray-600",
    smaller: "bg-red-100 text-red-800",
  }[fit.kind];
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}>
      {fit.kind === "exact" ? "✓ " : fit.kind === "smaller" ? "⚠ " : ""}{sizeFitText(fit)}
    </span>
  );
}

/* PER ITEM — cheapest and closest size (client, 16 Oct 2026)
 * "go by item … 尺寸最重要": who is cheapest, whose size is closest, and a
 * pick per item that follows the size (the purchaser can change it). Then
 * Option A (split the order by item) next to Option B (one supplier). */
function PerItem({
  picks, overrides, onPick, plan, result, items, isMaterial, awarding, onAward, message,
}: {
  picks: ItemPicks[];
  overrides: Record<string, string>;
  onPick: (itemId: string, supplierName: string) => void;
  plan: SplitPlan;
  result: ComparisonResult;
  items: RfqItemRow[];
  isMaterial: boolean;
  awarding: boolean;
  onAward: () => void;
  message: string;
}) {
  const one = result.recommended;
  const covered = items.length - plan.uncovered.length;
  const sameCoverage = one != null && one.quotedCount === covered && plan.uncovered.length === 0;
  return (
    <div>
      <div className="chart-title">{isMaterial ? "Per item — cheapest and closest size" : "Per item — cheapest"}</div>
      <p className="hint mb-1">
        {isMaterial
          ? "For each item: who is cheapest, and whose size is closest to what we asked. The pick follows the size (exact first, then the nearest bigger piece); change it if you prefer."
          : "For each item: who is cheapest. Change the pick if you prefer another supplier."}
      </p>
      <div className="overflow-x-auto tbl-wrap">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Cheapest</th>
              {isMaterial && <th scope="col">Closest size</th>}
              <th scope="col">Pick</th>
              <th scope="col">Line total</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p, k) => {
              const it = items[k];
              const o = pickedOffer(p, overrides[p.inquiry.id]);
              const spec = isMaterial
                ? [it?.material_type, [it?.thickness_raw, it?.height_raw, it?.length_raw].filter(Boolean).join(" × ")].filter(Boolean).join(" ")
                : it?.description ?? "";
              return (
                <tr key={p.inquiry.id}>
                  <td className="min-w-40">
                    <b>Item {k + 1}</b>
                    <div className="text-xs text-gray-500">{spec}{it?.qty != null ? ` · ${it.qty} pcs` : ""}</div>
                  </td>
                  <td>
                    {p.cheapest
                      ? <>{p.cheapest.supplierName} <span className="text-gray-500 whitespace-nowrap">({rm(p.cheapest.price)}/pc)</span></>
                      : <span className="text-gray-400">not quoted</span>}
                  </td>
                  {isMaterial && (
                    <td>
                      {p.closest
                        ? <>{p.closest.supplierName} <FitBadge fit={p.closest.fit} /></>
                        : <span className="text-gray-400">—</span>}
                    </td>
                  )}
                  <td>
                    {o ? (
                      <select
                        aria-label={`Supplier for item ${k + 1}`}
                        value={o.supplierName}
                        onChange={(e) => onPick(p.inquiry.id, e.target.value)}
                        className="fld text-sm max-w-72"
                      >
                        {p.offers.map((of) => (
                          <option key={of.supplierName} value={of.supplierName}>
                            {of.supplierName} — {rm(of.price)}{isMaterial ? ` · ${sizeFitText(of.fit)}` : ""}
                          </option>
                        ))}
                      </select>
                    ) : <span className="text-gray-400">nobody quoted</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    {o ? <>{rm(o.lineTotal)} <span className="text-xs text-gray-500">({o.qty} pcs)</span></> : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mt-3">
        <div className="card space-y-1">
          <div className="font-semibold">Option A — split by item</div>
          <div className="text-sm">
            {plan.bySupplier.length > 0
              ? plan.bySupplier.map((g) => `${g.supplierName} (${itemList(g.items)})`).join(" + ")
              : "No priced items yet."}
          </div>
          <div className="text-sm">
            Total: <b>{rm(plan.total)}</b>{" "}
            <span className="text-gray-500">· {covered}/{items.length} items, at the quoted quantities</span>
          </div>
          {plan.uncovered.length > 0 && (
            <div className="text-sm miss">⚠ {itemList(plan.uncovered)} — nobody quoted</div>
          )}
          <div className="flex gap-3 items-center flex-wrap pt-1">
            <button onClick={onAward} disabled={awarding || plan.bySupplier.length === 0} className="btn-award disabled:opacity-50">
              {awarding ? "Recording…" : "🏆 Award split & record in Purchase History"}
            </button>
            {message && <span className="text-green-800 text-sm">{message}</span>}
          </div>
          {plan.bySupplier.length > 1 && (
            <div className="hint">Writes one Purchase History row per supplier, with its items and subtotal.</div>
          )}
        </div>

        <div className="card space-y-1">
          <div className="font-semibold">Option B — one supplier</div>
          {one ? (
            <>
              <div className="text-sm">{one.supplierName}</div>
              <div className="text-sm">
                Total: <b>{rm(one.total)}</b>{" "}
                <span className="text-gray-500">· covers {one.quotedCount}/{items.length} items</span>
              </div>
              {sameCoverage && Math.abs(plan.total - one.total) >= 0.005 && (
                <div className="text-sm">
                  {plan.total < one.total
                    ? `Splitting saves ${rm(one.total - plan.total)}.`
                    : `One supplier is ${rm(plan.total - one.total)} cheaper.`}
                </div>
              )}
              <div className="hint">Same as Claude&apos;s Choice above — award it there.</div>
            </>
          ) : (
            <div className="text-sm text-gray-500">No comparable quote yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

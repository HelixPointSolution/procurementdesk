"use client";

/* Shared editor for Tab 1 (RFQ Material) and Tab 2 (RFQ General).
 *
 * Material items carry per-item material + dims + per-item Ref, and get
 * suggested supplier emails from the Supplier List (top-3 per material).
 * Dimension notation — "(9.50)" order size, "Ø4.00" diameter — is kept
 * verbatim from input to generated email.
 */

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { RfqKind, RfqRow, RfqItemRow } from "@/lib/types";
import { useSupplierData } from "@/lib/useSupplierData";
import { suggestSuppliers } from "@/lib/supplierMatch";
import {
  buildGeneralEmail,
  buildMaterialEmail,
  gmailComposeUrl,
  mailtoUrl,
} from "@/lib/email";

interface ItemDraft {
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

function toNumber(s: string): number | null {
  const n = Number(s);
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
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
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  async function loadList() {
    const { data } = await supabase()
      .from("rfqs").select("*").eq("kind", kind)
      .order("created_at", { ascending: false }).limit(100);
    setRfqs((data as RfqRow[]) ?? []);
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind]);

  function newRfq() {
    setCurrentId(null);
    setSubject("");
    setItems([{ ...BLANK }]);
    setPreview(null);
    setRecipients("");
    setSavedMsg("");
  }

  async function openRfq(id: string) {
    const sb = supabase();
    const [{ data: r }, { data: its }] = await Promise.all([
      sb.from("rfqs").select("*").eq("id", id).single(),
      sb.from("rfq_items").select("*").eq("rfq_id", id).order("position"),
    ]);
    if (!r) return;
    setCurrentId(id);
    setSubject((r as RfqRow).subject);
    setItems(
      ((its as RfqItemRow[]) ?? []).map((it) => ({
        materialType: it.material_type ?? "",
        description: it.description ?? "",
        thicknessRaw: it.thickness_raw ?? "",
        heightRaw: it.height_raw ?? "",
        lengthRaw: it.length_raw ?? "",
        qty: it.qty == null ? "" : String(it.qty),
        itemRef: it.item_ref ?? "",
      }))
    );
    setPreview(null);
    setSavedMsg("");
  }

  async function save(): Promise<string | null> {
    setBusy(true);
    const sb = supabase();
    const { data: userData } = await sb.auth.getUser();
    const createdBy = userData.user?.email ?? "";
    let id = currentId;
    if (id) {
      const { error } = await sb.from("rfqs").update({ subject }).eq("id", id);
      if (error) { alert(error.message); setBusy(false); return null; }
      await sb.from("rfq_items").delete().eq("rfq_id", id);
    } else {
      const { data, error } = await sb
        .from("rfqs")
        .insert({ kind, subject, created_by: createdBy })
        .select("id").single();
      if (error || !data) { alert(error?.message ?? "insert failed"); setBusy(false); return null; }
      id = data.id as string;
      setCurrentId(id);
    }
    const rows = items.map((it, i) => ({
      rfq_id: id,
      position: i,
      material_type: isMaterial ? it.materialType : null,
      description: isMaterial ? null : it.description,
      thickness_raw: isMaterial ? it.thicknessRaw : null,
      height_raw: isMaterial ? it.heightRaw : null,
      length_raw: isMaterial ? it.lengthRaw : null,
      qty: toNumber(it.qty),
      item_ref: it.itemRef,
    }));
    const { error: e2 } = await sb.from("rfq_items").insert(rows);
    if (e2) { alert(e2.message); setBusy(false); return null; }
    await loadList();
    setSavedMsg("Saved ✓");
    setBusy(false);
    return id;
  }

  async function deleteRfq(id: string) {
    if (!confirm("Delete this RFQ (and its quotes)?")) return;
    await supabase().from("rfqs").delete().eq("id", id);
    if (currentId === id) newRfq();
    await loadList();
  }

  // Per-item supplier suggestions (material RFQs only)
  const suggestions = useMemo(
    () =>
      isMaterial
        ? items.map((it) => suggestSuppliers(it.materialType, groups))
        : items.map(() => []),
    [isMaterial, items, groups]
  );

  function generate() {
    const em = isMaterial
      ? buildMaterialEmail(
          subject || "RFQ",
          items.map((it) => ({
            materialType: it.materialType,
            thicknessRaw: it.thicknessRaw,
            heightRaw: it.heightRaw,
            lengthRaw: it.lengthRaw,
            qty: toNumber(it.qty),
            itemRef: it.itemRef,
          }))
        )
      : buildGeneralEmail(
          subject || "RFQ",
          items.map((it) => ({
            description: it.description,
            qty: toNumber(it.qty),
            itemRef: it.itemRef,
          }))
        );
    setPreview(em);
    if (recipients.trim() === "") {
      const emails = [...new Set(suggestions.flat().map((s) => s.email).filter(Boolean))] as string[];
      setRecipients(emails.join(", "));
    }
  }

  function setItem(i: number, patch: Partial<ItemDraft>) {
    setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  const toList = recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

  return (
    <div className="grid md:grid-cols-[240px_1fr] gap-6">
      {/* Saved RFQs */}
      <aside>
        <button onClick={newRfq} className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium mb-3">
          + New RFQ
        </button>
        <div className="space-y-1">
          {rfqs.map((r) => (
            <div
              key={r.id}
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm cursor-pointer ${
                r.id === currentId ? "bg-blue-100" : "hover:bg-gray-100"
              }`}
              onClick={() => openRfq(r.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{r.subject || "(no subject)"}</div>
                <div className="text-xs text-gray-400">{new Date(r.created_at).toLocaleDateString()}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteRfq(r.id); }}
                className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 px-1"
              >
                ✕
              </button>
            </div>
          ))}
          {rfqs.length === 0 && <div className="text-xs text-gray-400 px-2">No saved RFQs yet.</div>}
        </div>
      </aside>

      {/* Editor */}
      <section className="space-y-4 min-w-0">
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-64">
            <label className="block text-sm font-medium mb-1">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={isMaterial ? "e.g. RFQ SO26-08134" : "e.g. RFQ Carbide Tap Mill"}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <button onClick={save} disabled={busy} className="bg-gray-900 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
            💾 Save
          </button>
          {savedMsg && <span className="text-green-600 text-sm pb-2">{savedMsg}</span>}
        </div>

        {isMaterial && (
          <p className="text-xs text-gray-500">
            Notation: <b>(00.00)</b> = order size in mm · <b>0.00</b> = finishing size (max
            allowance +5mm) · <b>Ø</b> = diameter (type Ø or paste it) — all kept exactly as
            typed, through to the email.
          </p>
        )}

        {/* Items */}
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={i} className="bg-white border rounded-lg p-3">
              <div className="flex gap-2 flex-wrap items-end">
                <span className="text-sm font-bold w-14 pb-2">Item {i + 1}</span>
                {isMaterial ? (
                  <>
                    <Field label="Material Type" w="w-32" value={it.materialType} onChange={(v) => setItem(i, { materialType: v })} placeholder="SS 304" />
                    <Field label="Thickness" w="w-24" value={it.thicknessRaw} onChange={(v) => setItem(i, { thicknessRaw: v })} placeholder="2.0 / Ø4.00" />
                    <Field label="Height" w="w-24" value={it.heightRaw} onChange={(v) => setItem(i, { heightRaw: v })} placeholder="3.0" />
                    <Field label="Length" w="w-24" value={it.lengthRaw} onChange={(v) => setItem(i, { lengthRaw: v })} placeholder="(9.50)" />
                  </>
                ) : (
                  <Field label="Description" w="flex-1 min-w-64" value={it.description} onChange={(v) => setItem(i, { description: v })} placeholder="Carbide Tap Mill 2.500mm X 3.30mm" />
                )}
                <Field label="Qty" w="w-16" value={it.qty} onChange={(v) => setItem(i, { qty: v })} placeholder="3" />
                <Field label="Ref" w="w-40" value={it.itemRef} onChange={(v) => setItem(i, { itemRef: v })} placeholder="SO26-08134 (1)" />
                <button
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                  disabled={items.length === 1}
                  className="text-red-400 hover:text-red-600 pb-2 disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
              {isMaterial && suggestions[i].length > 0 && (
                <div className="mt-2 flex gap-1 flex-wrap text-xs">
                  <span className="text-gray-400">Suggested:</span>
                  {suggestions[i].map((s) => (
                    <button
                      key={s.name}
                      title={`${s.category} — matched "${s.matchedKeyword}"`}
                      onClick={() => {
                        if (s.email && !toList.includes(s.email))
                          setRecipients(recipients ? recipients + ", " + s.email : s.email);
                      }}
                      className="bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5 hover:bg-blue-100"
                    >
                      {s.name}{s.email ? "" : " (no email)"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <button onClick={() => setItems([...items, { ...BLANK }])} className="border rounded-lg px-3 py-1.5 text-sm hover:bg-gray-100">
          + Add item
        </button>

        {/* Email */}
        <div className="flex gap-2 flex-wrap items-center border-t pt-4">
          <button onClick={generate} className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium">
            ✉️ Generate RFQ email
          </button>
          {preview && (
            <>
              <button
                onClick={() => navigator.clipboard.writeText(preview.body)}
                className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-100"
              >
                📋 Copy
              </button>
              <a
                href={gmailComposeUrl(toList, preview.subject, preview.body)}
                target="_blank" rel="noopener noreferrer"
                className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-100"
              >
                ✉️ Open in Gmail
              </a>
              <a
                href={mailtoUrl(toList, preview.subject, preview.body)}
                className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-100"
              >
                📨 Mail app
              </a>
            </>
          )}
        </div>
        {preview && (
          <div className="space-y-2">
            <div>
              <label className="block text-sm font-medium mb-1">To (from suggestions — edit freely)</label>
              <input
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="supplier1@x.com, supplier2@y.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Subject: {preview.subject}</label>
              <textarea
                readOnly
                value={preview.body}
                rows={Math.min(24, preview.body.split("\n").length + 1)}
                className="w-full border rounded-lg px-3 py-2 font-mono text-xs bg-gray-50"
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, w,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; w?: string;
}) {
  return (
    <div className={w}>
      <label className="block text-xs text-gray-500 mb-0.5">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border rounded-lg px-2 py-1.5 text-sm"
      />
    </div>
  );
}

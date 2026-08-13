"use client";

/* Tab 6 — Supplier List (master data).
 * Mirrors the Excel "Supplier List" tab: material groups (Category +
 * material keywords) each holding an ordered list of suppliers. The order
 * inside a group is the priority for RFQ "Suggest email 1/2/3".
 */

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useSupplierData } from "@/lib/useSupplierData";

export default function SuppliersPage() {
  const { suppliers, rows, groups, loading, error, reload } = useSupplierData();
  const [busy, setBusy] = useState(false);

  // new-supplier form
  const [nName, setNName] = useState("");
  const [nEmail, setNEmail] = useState("");
  const [nNote, setNNote] = useState("");
  // new-group form
  const [gCategory, setGCategory] = useState("");
  const [gMaterials, setGMaterials] = useState("");

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    const { error } = await fn();
    if (error) alert("Error: " + error.message);
    await reload();
    setBusy(false);
  }

  async function addSupplier() {
    if (!nName.trim()) return;
    await run(() =>
      supabase().from("suppliers").insert({
        name: nName.trim(),
        email: nEmail.trim() || null,
        note: nNote.trim(),
      })
    );
    setNName(""); setNEmail(""); setNNote("");
  }

  async function updateSupplier(id: string, patch: Record<string, unknown>) {
    await run(() => supabase().from("suppliers").update(patch).eq("id", id));
  }

  async function deleteSupplier(id: string, name: string) {
    if (!confirm(`Delete supplier "${name}"? Their group memberships go too.`)) return;
    await run(() => supabase().from("suppliers").delete().eq("id", id));
  }

  async function addGroup() {
    if (!gCategory.trim() || !gMaterials.trim()) return;
    // A group only exists through its member rows; require picking a supplier after.
    alert("Group created empty — now add a supplier to it below.");
    setGroupsDraft([...groupsDraft, { category: gCategory.trim().toUpperCase(), materials: gMaterials.trim() }]);
    setGCategory(""); setGMaterials("");
  }
  // Draft groups not yet persisted (they persist when the first member is added)
  const [groupsDraft, setGroupsDraft] = useState<Array<{ category: string; materials: string }>>([]);

  async function addMember(category: string, materials: string, supplierId: string) {
    if (!supplierId) return;
    const existing = rows.filter((r) => r.category === category && r.materials === materials);
    const maxOrder = Math.max(-1, ...existing.map((r) => r.sort_order));
    await run(() =>
      supabase().from("supplier_materials").insert({
        supplier_id: supplierId,
        category,
        materials,
        sort_order: maxOrder + 1,
      })
    );
    setGroupsDraft(groupsDraft.filter((d) => d.category !== category || d.materials !== materials));
  }

  async function removeMember(rowId: string) {
    await run(() => supabase().from("supplier_materials").delete().eq("id", rowId));
  }

  async function moveMember(rowId: string, dir: -1 | 1) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const siblings = rows
      .filter((r) => r.category === row.category && r.materials === row.materials)
      .sort((a, b) => a.sort_order - b.sort_order);
    const i = siblings.findIndex((r) => r.id === rowId);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const other = siblings[j];
    setBusy(true);
    const sb = supabase();
    await sb.from("supplier_materials").update({ sort_order: other.sort_order }).eq("id", row.id);
    await sb.from("supplier_materials").update({ sort_order: row.sort_order }).eq("id", other.id);
    await reload();
    setBusy(false);
  }

  async function updateGroupText(category: string, materials: string, patch: { category?: string; materials?: string }) {
    const ids = rows
      .filter((r) => r.category === category && r.materials === materials)
      .map((r) => r.id);
    await run(() => supabase().from("supplier_materials").update(patch).in("id", ids));
  }

  async function deleteGroup(category: string, materials: string) {
    if (!confirm(`Delete the whole "${category}" group for "${materials.slice(0, 60)}…"?`)) return;
    const ids = rows
      .filter((r) => r.category === category && r.materials === materials)
      .map((r) => r.id);
    await run(() => supabase().from("supplier_materials").delete().in("id", ids));
  }

  if (loading) return <div className="text-gray-500">Loading…</div>;
  if (error) return <div className="text-red-600">Error: {error} — is the schema applied? (supabase/schema.sql + seed.sql)</div>;

  const allGroups = [
    ...groups.map((g) => ({ ...g, draft: false })),
    ...groupsDraft.map((d) => ({ ...d, suppliers: [], rowIds: [], draft: true })),
  ];
  const categories = [...new Set(allGroups.map((g) => g.category))];

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xl font-bold mb-1">Supplier List</h2>
        <p className="text-sm text-gray-500 mb-4">
          Material groups drive the RFQ&apos;s suggested emails — order inside a group is priority (top = Suggest email 1).
        </p>

        {categories.map((cat) => (
          <div key={cat} className="mb-6">
            <h3 className="font-bold text-sm bg-gray-200 rounded-t-lg px-3 py-1.5">{cat}</h3>
            <div className="border border-t-0 rounded-b-lg divide-y">
              {allGroups.filter((g) => g.category === cat).map((g) => (
                <div key={g.category + g.materials} className="p-3">
                  <div className="flex items-start gap-2 mb-2">
                    <textarea
                      defaultValue={g.materials}
                      rows={Math.min(3, Math.ceil(g.materials.length / 90))}
                      className="flex-1 border rounded-lg px-2 py-1 text-sm font-medium"
                      onBlur={(e) => {
                        if (!g.draft && e.target.value.trim() !== g.materials)
                          updateGroupText(g.category, g.materials, { materials: e.target.value.trim() });
                      }}
                    />
                    {!g.draft && (
                      <button
                        onClick={() => deleteGroup(g.category, g.materials)}
                        className="text-red-500 hover:text-red-700 text-sm border rounded-lg px-2 py-1"
                        disabled={busy}
                      >
                        ✕ group
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {g.suppliers.map((s, i) => {
                      const sup = suppliers.find((x) => x.name === s.name);
                      return (
                        <div key={g.rowIds[i]} className="flex items-center gap-2 text-sm">
                          <span className="text-gray-400 w-5 text-right">{i + 1}.</span>
                          <span className="w-52 truncate font-medium">{s.name}</span>
                          <span className="flex-1 truncate text-gray-500">{s.email ?? sup?.note ?? ""}</span>
                          <button onClick={() => moveMember(g.rowIds[i], -1)} disabled={busy || i === 0} aria-label={`Move ${s.name} up`} title="Move up" className="px-2 py-1.5 text-gray-400 hover:text-black disabled:opacity-30">▲</button>
                          <button onClick={() => moveMember(g.rowIds[i], 1)} disabled={busy || i === g.suppliers.length - 1} aria-label={`Move ${s.name} down`} title="Move down" className="px-2 py-1.5 text-gray-400 hover:text-black disabled:opacity-30">▼</button>
                          <button onClick={() => removeMember(g.rowIds[i])} disabled={busy} aria-label={`Remove ${s.name} from group`} title="Remove from group" className="px-2 py-1.5 text-red-400 hover:text-red-600">✕</button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2">
                    <select
                      className="border rounded-lg px-2 py-1 text-sm"
                      defaultValue=""
                      onChange={(e) => addMember(g.category, g.materials, e.target.value)}
                      disabled={busy}
                    >
                      <option value="">+ add supplier to group…</option>
                      {suppliers
                        .filter((s) => !g.suppliers.some((m) => m.name === s.name))
                        .map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="bg-white border rounded-lg p-3 flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-gray-500">New group — Category</label>
            <input value={gCategory} onChange={(e) => setGCategory(e.target.value)} placeholder="e.g. STAINLESS STEEL" className="border rounded-lg px-2 py-1 text-sm" />
          </div>
          <div className="flex-1 min-w-60">
            <label className="block text-xs text-gray-500">Materials (comma-separated keywords)</label>
            <input value={gMaterials} onChange={(e) => setGMaterials(e.target.value)} placeholder="e.g. SUS 303, SUS 304, 316L" className="w-full border rounded-lg px-2 py-1 text-sm" />
          </div>
          <button onClick={addGroup} disabled={busy} className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm font-medium">+ Add group</button>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold mb-2">All suppliers</h2>
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 text-left">
              <tr>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Note</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-1">
                    <input defaultValue={s.name} className="w-full border-0 bg-transparent focus:bg-white focus:border rounded px-1 py-0.5"
                      onBlur={(e) => e.target.value.trim() !== s.name && updateSupplier(s.id, { name: e.target.value.trim() })} />
                  </td>
                  <td className="px-3 py-1">
                    <input defaultValue={s.email ?? ""} className="w-full border-0 bg-transparent focus:bg-white focus:border rounded px-1 py-0.5"
                      onBlur={(e) => (e.target.value.trim() || null) !== s.email && updateSupplier(s.id, { email: e.target.value.trim() || null })} />
                  </td>
                  <td className="px-3 py-1">
                    <input defaultValue={s.note} className="w-full border-0 bg-transparent focus:bg-white focus:border rounded px-1 py-0.5"
                      onBlur={(e) => e.target.value.trim() !== s.note && updateSupplier(s.id, { note: e.target.value.trim() })} />
                  </td>
                  <td className="px-3 py-1">
                    <button onClick={() => deleteSupplier(s.id, s.name)} disabled={busy} aria-label={`Delete supplier ${s.name}`} title="Delete supplier" className="text-red-400 hover:text-red-600 px-2 py-1.5">✕</button>
                  </td>
                </tr>
              ))}
              <tr className="bg-gray-50">
                <td className="px-3 py-2"><input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="New supplier name" className="w-full border rounded px-2 py-1" /></td>
                <td className="px-3 py-2"><input value={nEmail} onChange={(e) => setNEmail(e.target.value)} placeholder="email@…" className="w-full border rounded px-2 py-1" /></td>
                <td className="px-3 py-2"><input value={nNote} onChange={(e) => setNNote(e.target.value)} placeholder="note (e.g. Walk in to buy)" className="w-full border rounded px-2 py-1" /></td>
                <td className="px-3 py-2"><button onClick={addSupplier} disabled={busy || !nName.trim()} className="bg-blue-600 text-white rounded-lg px-2 py-1 text-xs font-medium">Add</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase/client";
import type { SupplierRow, SupplierMaterialRow } from "./types";
import type { MaterialGroup } from "./supplierMatch";

export interface GroupWithRows extends MaterialGroup {
  /** supplier_materials row ids, parallel to `suppliers` */
  rowIds: string[];
}

/** Load suppliers + material groups (assembled for supplierMatch). */
export function useSupplierData() {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [rows, setRows] = useState<SupplierMaterialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    const sb = supabase();
    const [s, m] = await Promise.all([
      sb.from("suppliers").select("*").order("name"),
      sb.from("supplier_materials").select("*").order("sort_order"),
    ]);
    if (s.error || m.error) {
      setError(s.error?.message || m.error?.message || "load failed");
    } else {
      setSuppliers(s.data as SupplierRow[]);
      setRows(m.data as SupplierMaterialRow[]);
      setError("");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const groupMap = new Map<string, GroupWithRows>();
  for (const r of rows) {
    const key = `${r.category}|||${r.materials}`;
    let g = groupMap.get(key);
    if (!g) {
      g = { category: r.category, materials: r.materials, suppliers: [], rowIds: [] };
      groupMap.set(key, g);
    }
    const sup = byId.get(r.supplier_id);
    if (sup) {
      g.suppliers.push({ name: sup.name, email: sup.email });
      g.rowIds.push(r.id);
    }
  }
  const groups = [...groupMap.values()];

  return { suppliers, rows, groups, loading, error, reload };
}

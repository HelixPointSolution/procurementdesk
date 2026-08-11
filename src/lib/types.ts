/** Database row types — mirror supabase/schema.sql. */

export interface SupplierRow {
  id: string;
  name: string;
  email: string | null;
  note: string;
}

export interface SupplierMaterialRow {
  id: string;
  supplier_id: string;
  category: string;
  materials: string;
  sort_order: number;
}

export type RfqKind = "material" | "general";

export interface RfqRow {
  id: string;
  kind: RfqKind;
  subject: string;
  payment_term: string;
  created_by: string;
  created_at: string;
}

export interface RfqItemRow {
  id: string;
  rfq_id: string;
  position: number;
  material_type: string | null;
  description: string | null;
  thickness_raw: string | null;
  height_raw: string | null;
  length_raw: string | null;
  qty: number | null;
  item_ref: string | null;
}

export interface QuoteRow {
  id: string;
  rfq_id: string;
  supplier_name: string;
  supplier_id: string | null;
  notes: string;
  created_at: string;
}

export interface QuoteItemRow {
  id: string;
  quote_id: string;
  rfq_item_id: string;
  thickness_raw: string | null;
  height_raw: string | null;
  length_raw: string | null;
  qty: number | null;
  price: number | null;
  notes: string;
}

export interface PurchaseHistoryRow {
  id: string;
  rfq_id: string | null;
  date: string;
  ref: string;
  awarded_to: string;
  total_rm: number | null;
  notes: string;
  created_by: string;
}

export interface ScorecardRow {
  id: string;
  supplier_name: string;
  scores: number[];
  note: string;
  updated_by: string;
  updated_at: string;
}

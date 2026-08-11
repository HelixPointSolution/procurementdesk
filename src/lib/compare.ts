/* Quote-comparison engine for material RFQs.
 *
 * Tolerates the realities the Excel spec demonstrates:
 *   - a supplier may quote different dimensions than asked (off-spec)
 *   - a supplier may skip items entirely ("No stock for item 2")
 * Ranks by normalised RM/kg (the Excel's "fair ruler"), preferring
 * full-coverage + full-spec suppliers, and explains its reasoning so the
 * purchaser can overrule it (Purchaser's Choice always wins).
 */

import { dimsMatch } from "./dimensions";
import { pieceWeightKg } from "./weight";

export interface InquiryItem {
  id: string;
  materialType: string;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: number | null;
  itemRef: string;
}

export interface QuoteItemInput {
  rfqItemId: string;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: number | null;
  price: number | null; // RM per pc
  notes: string;
}

export interface SupplierQuoteInput {
  supplierName: string;
  notes: string;
  items: QuoteItemInput[]; // items NOT quoted are simply absent
}

export interface ItemAnalysis {
  inquiry: InquiryItem;
  quoted: QuoteItemInput | null;
  thicknessOk: boolean;
  heightOk: boolean;
  lengthOk: boolean;
  qtyOk: boolean;
  specOk: boolean;
  lineTotal: number | null; // price × inquiry qty
  lineWeightKg: number | null; // quoted-dims piece weight × qty
}

export interface SupplierAnalysis {
  supplierName: string;
  notes: string;
  items: ItemAnalysis[];
  quotedCount: number;
  fullCoverage: boolean;
  fullSpec: boolean;
  total: number; // RM over quoted items
  weightKg: number; // over quoted items with computable weight
  rmPerKg: number | null;
}

export interface ComparisonResult {
  suppliers: SupplierAnalysis[];
  /** "Claude's Choice" — null when nothing is comparable. */
  recommended: SupplierAnalysis | null;
  reasoning: string;
}

export function analyseQuotes(
  inquiry: InquiryItem[],
  quotes: SupplierQuoteInput[]
): ComparisonResult {
  const suppliers = quotes.map((q): SupplierAnalysis => {
    const byItem = new Map(q.items.map((qi) => [qi.rfqItemId, qi]));
    const items = inquiry.map((inq): ItemAnalysis => {
      const quoted = byItem.get(inq.id) ?? null;
      if (!quoted || quoted.price == null) {
        return {
          inquiry: inq, quoted: null,
          thicknessOk: false, heightOk: false, lengthOk: false, qtyOk: false,
          specOk: false, lineTotal: null, lineWeightKg: null,
        };
      }
      const thicknessOk = dimsMatch(inq.thicknessRaw, quoted.thicknessRaw);
      const heightOk = dimsMatch(inq.heightRaw, quoted.heightRaw);
      const lengthOk = dimsMatch(inq.lengthRaw, quoted.lengthRaw);
      const qtyOk = quoted.qty == null || inq.qty == null || quoted.qty === inq.qty;
      const qty = inq.qty ?? 0;
      const pcW = pieceWeightKg({
        materialType: inq.materialType,
        thicknessRaw: quoted.thicknessRaw || inq.thicknessRaw,
        heightRaw: quoted.heightRaw || inq.heightRaw,
        lengthRaw: quoted.lengthRaw || inq.lengthRaw,
      });
      return {
        inquiry: inq, quoted,
        thicknessOk, heightOk, lengthOk, qtyOk,
        specOk: thicknessOk && heightOk && lengthOk && qtyOk,
        lineTotal: quoted.price * qty,
        lineWeightKg: pcW == null ? null : pcW * qty,
      };
    });
    const quotedItems = items.filter((it) => it.quoted !== null);
    const total = quotedItems.reduce((a, it) => a + (it.lineTotal ?? 0), 0);
    const weightKg = quotedItems.reduce((a, it) => a + (it.lineWeightKg ?? 0), 0);
    return {
      supplierName: q.supplierName,
      notes: q.notes,
      items,
      quotedCount: quotedItems.length,
      fullCoverage: quotedItems.length === inquiry.length,
      fullSpec: quotedItems.length > 0 && quotedItems.every((it) => it.specOk),
      total,
      weightKg,
      rmPerKg: weightKg > 0 ? total / weightKg : null,
    };
  });

  const candidates = suppliers.filter((s) => s.quotedCount > 0);
  if (candidates.length === 0) {
    return { suppliers, recommended: null, reasoning: "No quotes entered yet." };
  }

  // Preference tiers: full coverage + full spec → full coverage → anyone.
  const tiers = [
    candidates.filter((s) => s.fullCoverage && s.fullSpec),
    candidates.filter((s) => s.fullCoverage),
    candidates,
  ];
  const pool = tiers.find((t) => t.length > 0)!;
  const metric = (s: SupplierAnalysis) => s.rmPerKg ?? s.total / Math.max(s.quotedCount, 1);
  const recommended = pool.reduce((a, b) => (metric(a) <= metric(b) ? a : b));

  const parts: string[] = [];
  parts.push(
    recommended.rmPerKg != null
      ? `Best value at RM ${recommended.rmPerKg.toFixed(2)}/kg (total RM ${recommended.total.toFixed(2)}).`
      : `Best total at RM ${recommended.total.toFixed(2)}.`
  );
  if (!recommended.fullSpec) parts.push("⚠ Not an exact spec match — confirm before ordering.");
  if (!recommended.fullCoverage)
    parts.push(`⚠ Only quotes ${recommended.quotedCount}/${inquiry.length} items — the rest need another supplier.`);
  const offSpec = candidates.filter((s) => !s.fullSpec);
  if (offSpec.length > 0)
    parts.push(`Off-spec quotes to re-check: ${offSpec.map((s) => s.supplierName).join(", ")}.`);
  return { suppliers, recommended, reasoning: parts.join(" ") };
}

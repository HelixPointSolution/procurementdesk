/* Quote-comparison engine for material RFQs.
 *
 * Tolerates the realities the client's spec demonstrates:
 *   - a supplier may quote different dimensions than asked (off-spec)
 *   - a supplier may skip items entirely ("No stock for item 2")
 *
 * Ranking rule (deliberately conservative — this picks who gets the money):
 *   - RM/kg is only used when EVERY quoted line has a computable weight.
 *     Mixing a full RM total against a partial kg total inflates RM/kg and
 *     makes the ranking arithmetically meaningless.
 *   - Otherwise suppliers are ranked on total RM.
 *   - RM/kg and total RM are never compared against each other in one sort:
 *     they are different units, and doing so silently picks the wrong winner.
 *   - A line with no usable quantity is NOT priced at zero. Zero would make
 *     that supplier the cheapest and win the award.
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
  /** Quantity actually used for pricing (the supplier's, else the inquiry's). */
  effectiveQty: number | null;
  lineTotal: number | null;
  lineWeightKg: number | null;
  /** Set when the line could not be priced, e.g. no usable quantity. */
  issue: string | null;
}

export interface SupplierAnalysis {
  supplierName: string;
  notes: string;
  items: ItemAnalysis[];
  quotedCount: number;
  /** Lines that were quoted AND could be priced. */
  pricedCount: number;
  fullCoverage: boolean;
  fullSpec: boolean;
  total: number;
  weightKg: number;
  /** Only set when every priced line had a computable weight. */
  rmPerKg: number | null;
  /** True when some priced line had no weight, so RM/kg is not meaningful. */
  weightIncomplete: boolean;
  issues: string[];
}

export interface ComparisonResult {
  suppliers: SupplierAnalysis[];
  /** "Claude's Choice" — null when nothing is comparable. */
  recommended: SupplierAnalysis | null;
  /** Which unit the ranking used, so the UI can say so honestly. */
  rankedBy: "rmPerKg" | "total" | null;
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
      const base = {
        inquiry: inq,
        thicknessOk: false, heightOk: false, lengthOk: false, qtyOk: false,
        specOk: false, effectiveQty: null, lineTotal: null, lineWeightKg: null,
      };
      if (!quoted || quoted.price == null) {
        return { ...base, quoted: null, issue: null };
      }

      const thicknessOk = dimsMatch(inq.thicknessRaw, quoted.thicknessRaw);
      const heightOk = dimsMatch(inq.heightRaw, quoted.heightRaw);
      const lengthOk = dimsMatch(inq.lengthRaw, quoted.lengthRaw);
      const qtyOk = quoted.qty == null || inq.qty == null || quoted.qty === inq.qty;

      // Price at the quantity the supplier actually quoted (MOQ realities),
      // falling back to what we asked for. Never default to 0 — that would
      // zero the line total and make this supplier win the award.
      const effectiveQty = quoted.qty ?? inq.qty ?? null;
      if (effectiveQty == null) {
        return {
          ...base, quoted,
          thicknessOk, heightOk, lengthOk, qtyOk,
          specOk: thicknessOk && heightOk && lengthOk && qtyOk,
          issue: `Item ${inquiry.indexOf(inq) + 1}: no quantity — cannot price`,
        };
      }

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
        effectiveQty,
        lineTotal: quoted.price * effectiveQty,
        lineWeightKg: pcW == null ? null : pcW * effectiveQty,
        issue: null,
      };
    });

    const quotedItems = items.filter((it) => it.quoted !== null);
    const pricedItems = quotedItems.filter((it) => it.lineTotal != null);
    const total = pricedItems.reduce((a, it) => a + (it.lineTotal ?? 0), 0);
    const weightKg = pricedItems.reduce((a, it) => a + (it.lineWeightKg ?? 0), 0);
    const weightIncomplete = pricedItems.some((it) => it.lineWeightKg == null);

    const issues = quotedItems.map((it) => it.issue).filter((x): x is string => x != null);
    if (weightIncomplete && pricedItems.length > 0) {
      issues.push("RM/kg unavailable — some lines have no computable weight");
    }

    return {
      supplierName: q.supplierName,
      notes: q.notes,
      items,
      quotedCount: quotedItems.length,
      pricedCount: pricedItems.length,
      fullCoverage: quotedItems.length === inquiry.length,
      fullSpec: quotedItems.length > 0 && quotedItems.every((it) => it.specOk),
      total,
      weightKg,
      // Only meaningful when every priced line contributed weight.
      rmPerKg: !weightIncomplete && weightKg > 0 ? total / weightKg : null,
      weightIncomplete,
      issues,
    };
  });

  const candidates = suppliers.filter((s) => s.pricedCount > 0);
  if (candidates.length === 0) {
    return {
      suppliers, recommended: null, rankedBy: null,
      reasoning: suppliers.length === 0
        ? "No quotes entered yet."
        : "No supplier has a priceable line yet — check quantities and prices.",
    };
  }

  // Preference tiers: full coverage + full spec → full coverage → anyone.
  const tiers = [
    candidates.filter((s) => s.fullCoverage && s.fullSpec),
    candidates.filter((s) => s.fullCoverage),
    candidates,
  ];
  const pool = tiers.find((t) => t.length > 0)!;

  // Rank on RM/kg only if EVERY supplier in the pool has one; else on total.
  const allHaveRmPerKg = pool.every((s) => s.rmPerKg != null);
  const rankedBy: "rmPerKg" | "total" = allHaveRmPerKg ? "rmPerKg" : "total";
  const metric = (s: SupplierAnalysis) =>
    rankedBy === "rmPerKg" ? (s.rmPerKg as number) : s.total;
  const recommended = pool.reduce((a, b) => (metric(a) <= metric(b) ? a : b));

  const parts: string[] = [];
  parts.push(
    rankedBy === "rmPerKg"
      ? `Best value at RM ${(recommended.rmPerKg as number).toFixed(2)}/kg (total RM ${recommended.total.toFixed(2)}).`
      : `Lowest total at RM ${recommended.total.toFixed(2)}${
          pool.some((s) => s.weightIncomplete)
            ? " — ranked on total because RM/kg could not be computed for every supplier."
            : "."
        }`
  );
  if (!recommended.fullSpec) parts.push("⚠ Not an exact spec match — confirm before ordering.");
  if (!recommended.fullCoverage)
    parts.push(`⚠ Only quotes ${recommended.quotedCount}/${inquiry.length} items — the rest need another supplier.`);
  const offSpec = candidates.filter((s) => !s.fullSpec);
  if (offSpec.length > 0)
    parts.push(`Off-spec quotes to re-check: ${offSpec.map((s) => s.supplierName).join(", ")}.`);
  const withIssues = candidates.filter((s) => s.issues.length > 0);
  if (withIssues.length > 0)
    parts.push(`Incomplete data: ${withIssues.map((s) => s.supplierName).join(", ")}.`);

  return { suppliers, recommended, rankedBy, reasoning: parts.join(" ") };
}

/** Chart 2 ordering: cheapest RM/kg first, suppliers without one last, stable. */
export function byRmPerKg(a: SupplierAnalysis, b: SupplierAnalysis): number {
  if (a.rmPerKg == null && b.rmPerKg == null) return a.total - b.total;
  if (a.rmPerKg == null) return 1;
  if (b.rmPerKg == null) return -1;
  return a.rmPerKg - b.rmPerKg;
}

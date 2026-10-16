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

import { dimsMatch, sizeFit, type SizeFit, type SizeFitKind } from "./dimensions";
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
  /** Size compared with the inquiry, ignoring dimension order. Null when not quoted. */
  fit: SizeFit | null;
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
        specOk: false, fit: null, effectiveQty: null, lineTotal: null, lineWeightKg: null,
      };
      if (!quoted || quoted.price == null) {
        return { ...base, quoted: null, issue: null };
      }

      // Same values in a different order (60 × 15 × 90 for our 15 × 60 × 90)
      // is the same piece, not three mismatches.
      const fit = sizeFit(
        [inq.thicknessRaw, inq.heightRaw, inq.lengthRaw],
        [quoted.thicknessRaw, quoted.heightRaw, quoted.lengthRaw]
      );
      const exact = fit.kind === "exact";
      const thicknessOk = exact || dimsMatch(inq.thicknessRaw, quoted.thicknessRaw);
      const heightOk = exact || dimsMatch(inq.heightRaw, quoted.heightRaw);
      const lengthOk = exact || dimsMatch(inq.lengthRaw, quoted.lengthRaw);
      const qtyOk = quoted.qty == null || inq.qty == null || quoted.qty === inq.qty;

      // Price at the quantity the supplier actually quoted (MOQ realities),
      // falling back to what we asked for. Never default to 0 — that would
      // zero the line total and make this supplier win the award.
      const effectiveQty = quoted.qty ?? inq.qty ?? null;
      if (effectiveQty == null) {
        return {
          ...base, quoted,
          thicknessOk, heightOk, lengthOk, qtyOk, fit,
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
        thicknessOk, heightOk, lengthOk, qtyOk, fit,
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

/* ---------- Per item: cheapest and closest size ----------
 *
 * Client, 16 Oct 2026: "go by item … 尺寸最重要" — for each item, show who is
 * cheapest and whose size is closest to what we asked, and pick per item with
 * SIZE FIRST. An exact size beats a bigger piece (usable, needs machining
 * down), which beats an unstated size, which beats a piece that is too small
 * (cannot make the part). Within the same kind, the smaller difference wins,
 * then the lower price. The purchaser can override any pick.
 */

export interface ItemOffer {
  supplierName: string;
  /** RM per piece as quoted. */
  price: number;
  /** Quantity the line is priced at. */
  qty: number;
  lineTotal: number;
  fit: SizeFit;
}

export interface ItemPicks {
  inquiry: InquiryItem;
  /** Every priced offer, preferred first (size first for material, price otherwise). */
  offers: ItemOffer[];
  cheapest: ItemOffer | null;
  /** Best size match. Null for general (non-material) RFQs. */
  closest: ItemOffer | null;
}

const FIT_RANK: Record<SizeFitKind, number> = { exact: 0, bigger: 1, unknown: 2, smaller: 3 };

/** Size first, then the smaller difference, then price. */
export function bySizeThenPrice(a: ItemOffer, b: ItemOffer): number {
  return FIT_RANK[a.fit.kind] - FIT_RANK[b.fit.kind] || a.fit.deltaMm - b.fit.deltaMm || a.price - b.price;
}

function byPriceThenSize(a: ItemOffer, b: ItemOffer): number {
  return a.price - b.price || bySizeThenPrice(a, b);
}

export function perItemPicks(result: ComparisonResult, inquiry: InquiryItem[], sizeMatters: boolean): ItemPicks[] {
  return inquiry.map((inq, k) => {
    const offers: ItemOffer[] = result.suppliers.flatMap((s) => {
      const a = s.items[k];
      if (!a?.quoted || a.quoted.price == null || a.lineTotal == null || a.effectiveQty == null) return [];
      return [{
        supplierName: s.supplierName,
        price: a.quoted.price,
        qty: a.effectiveQty,
        lineTotal: a.lineTotal,
        fit: a.fit ?? { kind: "unknown", deltaMm: 0 },
      }];
    });
    offers.sort(sizeMatters ? bySizeThenPrice : byPriceThenSize);
    return {
      inquiry: inq,
      offers,
      cheapest: offers.slice().sort(byPriceThenSize)[0] ?? null,
      closest: sizeMatters ? offers[0] ?? null : null,
    };
  });
}

/** The purchaser's override when it is still on offer, else the preferred offer. */
export function pickedOffer(p: ItemPicks, override: string | undefined): ItemOffer | null {
  return p.offers.find((o) => o.supplierName === override) ?? p.offers[0] ?? null;
}

export interface SplitPlan {
  total: number;
  /** One entry per supplier, in item order. `items` are 0-based indexes. */
  bySupplier: Array<{ supplierName: string; items: number[]; subtotal: number }>;
  /** Items nobody priced. */
  uncovered: number[];
}

/** Option A — order each item from its picked supplier. */
export function splitPlan(picks: ItemPicks[], overrides: Record<string, string>): SplitPlan {
  const groups = new Map<string, { supplierName: string; items: number[]; subtotal: number }>();
  const uncovered: number[] = [];
  let total = 0;
  picks.forEach((p, k) => {
    const o = pickedOffer(p, overrides[p.inquiry.id]);
    if (!o) { uncovered.push(k); return; }
    total += o.lineTotal;
    const g = groups.get(o.supplierName) ?? { supplierName: o.supplierName, items: [], subtotal: 0 };
    g.items.push(k);
    g.subtotal += o.lineTotal;
    groups.set(o.supplierName, g);
  });
  return { total, bySupplier: [...groups.values()], uncovered };
}

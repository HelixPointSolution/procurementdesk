import { describe, it, expect } from "vitest";
import { sizeFit, sizeFitText } from "../dimensions";
import {
  analyseQuotes, perItemPicks, pickedOffer, splitPlan,
  type InquiryItem, type QuoteItemInput,
} from "../compare";
import { sliceRanges } from "../prepareUpload";

describe("sizeFit — order-independent size comparison", () => {
  it("treats the same values in another order as exact (H × T × L for our T × H × L)", () => {
    expect(sizeFit(["15.00", "60.00", "90.00"], ["60.00", "15.00", "90.00"])).toEqual({ kind: "exact", deltaMm: 0 });
    expect(sizeFit(["15.00", "60.00", "(90.00)"], ["15.0", "60.0", "90.0"]).kind).toBe("exact");
  });
  it("calls a piece with nothing under size 'bigger', with the total excess", () => {
    expect(sizeFit(["20", "100", "118"], ["25", "105", "123"])).toEqual({ kind: "bigger", deltaMm: 15 });
  });
  it("calls a piece with any dimension under size 'smaller'", () => {
    expect(sizeFit(["20", "100", "118"], ["18", "105", "123"])).toEqual({ kind: "smaller", deltaMm: 2 });
  });
  it("cannot judge a size the supplier did not state", () => {
    expect(sizeFit(["20", "100", "118"], ["", "", ""]).kind).toBe("unknown");
    expect(sizeFit(["20", "100", "118"], ["20", "", "118"]).kind).toBe("unknown");
  });
  it("handles round bar (Ø × length)", () => {
    expect(sizeFit(["Ø50", "", "200"], ["Ø50", "", "200"]).kind).toBe("exact");
    expect(sizeFit(["Ø50", "", "200"], ["Ø55", "", "205"])).toEqual({ kind: "bigger", deltaMm: 10 });
  });
  it("reads as plain words", () => {
    expect(sizeFitText({ kind: "bigger", deltaMm: 1.5 })).toBe("bigger +1.5 mm");
    expect(sizeFitText({ kind: "smaller", deltaMm: 2 })).toBe("too small −2 mm");
  });
});

const inq = (id: string, t: string, h: string, l: string, qty: number): InquiryItem => ({
  id, materialType: "P20", thicknessRaw: t, heightRaw: h, lengthRaw: l, qty, itemRef: "",
});
const line = (rfqItemId: string, price: number, t: string, h: string, l: string, qty: number | null = null): QuoteItemInput => ({
  rfqItemId, thicknessRaw: t, heightRaw: h, lengthRaw: l, qty, price, notes: "",
});

describe("analyseQuotes — dimension order no longer flags off-spec", () => {
  it("marks a reordered but identical size as on spec", () => {
    const r = analyseQuotes([inq("a", "15.00", "60.00", "90.00", 2)], [
      { supplierName: "B", notes: "", items: [line("a", 30, "60.00", "15.00", "90.00", 2)] },
    ]);
    const it = r.suppliers[0].items[0];
    expect(it.specOk).toBe(true);
    expect([it.thicknessOk, it.heightOk, it.lengthOk]).toEqual([true, true, true]);
    expect(r.suppliers[0].fullSpec).toBe(true);
  });
});

describe("perItemPicks — per item, size first then price (client, 16 Oct)", () => {
  const items = [
    inq("a", "20", "100", "118", 2),
    inq("b", "24", "39", "55", 1),
    inq("c", "26", "32", "55", 1),
  ];
  const r = analyseQuotes(items, [
    { supplierName: "CHEAP", notes: "", items: [
      line("a", 40, "20", "100", "118"),   // exact and cheapest
      line("b", 10, "22", "39", "55"),     // too small — cheapest but unusable
      line("c", 15, "27", "33", "56"),     // bigger +3
    ] },
    { supplierName: "EXACT", notes: "", items: [
      line("a", 45, "100", "20", "118"),   // exact (reordered)
      line("b", 20, "24", "39", "55"),     // exact
      line("c", 18, "26.5", "32", "55"),   // bigger +0.5 — closer
    ] },
  ]);
  const picks = perItemPicks(r, items, true);

  it("shows the cheapest and the closest size separately", () => {
    expect(picks[1].cheapest?.supplierName).toBe("CHEAP");
    expect(picks[1].closest?.supplierName).toBe("EXACT");
  });
  it("breaks a size tie on price", () => {
    expect(picks[0].closest?.supplierName).toBe("CHEAP");
  });
  it("prefers the nearer bigger piece, even when dearer", () => {
    expect(picks[2].closest?.supplierName).toBe("EXACT");
    expect(picks[2].closest?.fit).toEqual({ kind: "bigger", deltaMm: 0.5 });
  });
  it("lets the purchaser override a pick, and ignores a stale override", () => {
    expect(pickedOffer(picks[1], "CHEAP")?.supplierName).toBe("CHEAP");
    expect(pickedOffer(picks[1], "GONE")?.supplierName).toBe("EXACT");
  });
  it("picks by price alone for general RFQs", () => {
    expect(perItemPicks(r, items, false)[1].offers[0].supplierName).toBe("CHEAP");
    expect(perItemPicks(r, items, false)[1].closest).toBeNull();
  });

  it("totals Option A at quantity, grouped per supplier", () => {
    const plan = splitPlan(picks, {});
    // a: CHEAP 40 × 2, b: EXACT 20 × 1, c: EXACT 18 × 1
    expect(plan.total).toBeCloseTo(118, 2);
    expect(plan.bySupplier).toEqual([
      { supplierName: "CHEAP", items: [0], subtotal: 80 },
      { supplierName: "EXACT", items: [1, 2], subtotal: 38 },
    ]);
    expect(plan.uncovered).toEqual([]);
  });
  it("lists items nobody priced", () => {
    const more = [...items, inq("d", "10", "10", "10", 1)];
    const r2 = analyseQuotes(more, [{ supplierName: "X", notes: "", items: [line("a", 5, "20", "100", "118")] }]);
    expect(splitPlan(perItemPicks(r2, more, true), {}).uncovered).toEqual([1, 2, 3]);
  });
});

describe("sliceRanges — long screenshots become readable pages", () => {
  it("leaves a normal picture whole", () => {
    expect(sliceRanges(1080, 1500)).toEqual([{ y: 0, h: 1500 }]);
    expect(sliceRanges(4000, 3000)).toEqual([{ y: 0, h: 3000 }]);
  });
  it("cuts a tall screenshot into overlapping pages that cover it exactly", () => {
    const pages = sliceRanges(1080, 6000);
    expect(pages.length).toBe(5);
    expect(pages[0].y).toBe(0);
    const last = pages[pages.length - 1];
    expect(last.y + last.h).toBe(6000);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].y).toBeLessThan(pages[i - 1].y + pages[i - 1].h); // overlaps the page before
    }
    for (const p of pages) expect(p.h / 1080).toBeLessThan(1.3);
  });
  it("never makes more than 8 pages", () => {
    expect(sliceRanges(500, 50_000).length).toBe(8);
  });
});

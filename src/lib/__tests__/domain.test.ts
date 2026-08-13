import { describe, it, expect } from "vitest";
import { parseDim, dimsMatch, isRoundItem } from "../dimensions";
import { densityFor, pieceWeightKg } from "../weight";
import { suggestSuppliers, type MaterialGroup } from "../supplierMatch";
import { buildMaterialEmail, buildGeneralEmail, gmailComposeUrl } from "../email";
import { analyseQuotes, byRmPerKg, type InquiryItem } from "../compare";
import { parseNumber, parseQty, parsePrice } from "../num";

describe("parseDim — notation rules from the spec", () => {
  it("parses plain numbers (finishing size)", () => {
    expect(parseDim("2.0")).toMatchObject({ value: 2, isBracket: false, isDiameter: false });
  });
  it("parses bracket notation (order size) — calc same with or without", () => {
    expect(parseDim("(9.50)")).toMatchObject({ value: 9.5, isBracket: true });
    expect(parseDim("(3.50)")!.value).toBe(3.5);
  });
  it("parses Ø diameters — calc same, symbol must survive", () => {
    const d = parseDim("Ø4.00")!;
    expect(d.value).toBe(4);
    expect(d.isDiameter).toBe(true);
    expect(d.raw).toBe("Ø4.00");
  });
  it("handles blanks and junk", () => {
    expect(parseDim("")).toBeNull();
    expect(parseDim(null)).toBeNull();
    expect(parseDim("abc")).toBeNull();
  });
  it("dimsMatch ignores notation, compares values", () => {
    expect(dimsMatch("(4.00)", "4.0")).toBe(true);
    expect(dimsMatch("Ø4.00", "4")).toBe(true);
    expect(dimsMatch("2.0", "3.0")).toBe(false);
  });
  it("isRoundItem detects Ø in any dim", () => {
    expect(isRoundItem("Ø4.00", "5.0", "(3.50)")).toBe(true);
    expect(isRoundItem("2.0", "3.0", "5.0")).toBe(false);
  });
});

describe("num — shared money/qty parsing", () => {
  it("accepts thousands separators (regression: prices were silently dropped)", () => {
    expect(parseNumber("1,250.00")).toBe(1250);
    expect(parsePrice("1,250")).toBe(1250);
  });
  it("accepts a currency prefix", () => {
    expect(parseNumber("RM 25.00")).toBe(25);
    expect(parseNumber("$18.5")).toBe(18.5);
  });
  it("rejects blanks and junk", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
  it("qty must be positive; price may be zero but not negative", () => {
    expect(parseQty("0")).toBeNull();
    expect(parseQty("-2")).toBeNull();
    expect(parseQty("3")).toBe(3);
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice("-1")).toBeNull();
  });
});

describe("weight — formulas from the spec workbook", () => {
  it("rectangular: 20 × 50 × 200 steel = 1.6 kg", () => {
    expect(pieceWeightKg({ materialType: "SS 304", thicknessRaw: "20", heightRaw: "50", lengthRaw: "200" }))
      .toBeCloseTo(1.6, 3);
  });
  it("round: Ø50 × 200 steel = 3.3 kg (workbook's example says 303 — decimal typo)", () => {
    const kg = pieceWeightKg({ materialType: "440C", thicknessRaw: "", heightRaw: "Ø50", lengthRaw: "200" })!;
    expect(kg).toBeCloseTo(3.3, 1);
  });
  it("round bar uses the Length column, not the first spare dim (regression: ~6.7× under-weight)", () => {
    const kg = pieceWeightKg({ materialType: "440C", thicknessRaw: "Ø50", heightRaw: "30", lengthRaw: "200" })!;
    expect(kg).toBeCloseTo(50 * 50 * 200 * 0.0000066, 6);
  });
  it("round bar survives two dims holding identical text", () => {
    // Previously filtered by value, so both were discarded and weight was null.
    expect(pieceWeightKg({ materialType: "440C", thicknessRaw: "Ø50", heightRaw: "", lengthRaw: "Ø50" }))
      .not.toBeNull();
  });
  it("aluminium scales by density", () => {
    expect(pieceWeightKg({ materialType: "Alu 6061", thicknessRaw: "20", heightRaw: "50", lengthRaw: "200" })!)
      .toBeCloseTo(1.6 * (2.7 / 8.0), 3);
  });
  it("plastics have no meaningful RM/kg", () => {
    expect(densityFor("PEEK")).toBeNull();
    expect(pieceWeightKg({ materialType: "TEFLON", thicknessRaw: "20", heightRaw: "50", lengthRaw: "200" })).toBeNull();
  });
  it("unknown material defaults to the steel constant", () => {
    expect(densityFor("mystery metal")).toBe(8.0);
  });
});

const GROUPS: MaterialGroup[] = [
  {
    category: "STAINLESS STEEL",
    materials: "SUS 303, SUS 304, SUS 316, 316L",
    suppliers: [
      { name: "Beye", email: "sales@beye.com.my" },
      { name: "PHH", email: "sales06@phh.com.my" },
      { name: "Heap Sing Huat", email: "skkoay@hsh.com.my" },
      { name: "Villgend", email: "villgend@gmail.com" },
    ],
  },
  {
    category: "ALU",
    materials: "ALU 6061, ALU 7075, ALU 5083, ALU 5052",
    suppliers: [
      { name: "YanKong", email: "sales.ykinorthern@gmail.com" },
      { name: "Twin Metal", email: "sales04@twinmetal.com.my" },
    ],
  },
  {
    category: "ALLOY STEEL",
    materials: "440C, SS400, STAVAX, SUS420J2",
    suppliers: [{ name: "Wong Tool", email: "wongtoolsteel@gmail.com" }],
  },
];

describe("supplierMatch — normalisation + aliases", () => {
  it("'SS 304' finds the SUS 304 group in list order", () => {
    expect(suggestSuppliers("SS 304", GROUPS).map((x) => x.name))
      .toEqual(["Beye", "PHH", "Heap Sing Huat"]);
  });
  it("'SS304' (no space) also matches", () => {
    expect(suggestSuppliers("SS304", GROUPS)[0].name).toBe("Beye");
  });
  it("'Alu 6061' matches the ALU group", () => {
    expect(suggestSuppliers("Alu 6061", GROUPS)[0].name).toBe("YanKong");
  });
  it("'5051' aliases into the ALU 5052 family", () => {
    expect(suggestSuppliers("5051", GROUPS)[0].name).toBe("YanKong");
  });
  it("'440C' matches alloy steel", () => {
    expect(suggestSuppliers("440C", GROUPS)[0].name).toBe("Wong Tool");
  });
  it("unknown material returns empty", () => {
    expect(suggestSuppliers("UNOBTAINIUM X99", GROUPS)).toEqual([]);
  });
});

describe("email — v1 numbered-line format", () => {
  const items = [
    { materialType: "SS 304", thicknessRaw: "2.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, itemRef: "SO26-08134 (1)" },
    { materialType: "SS304", thicknessRaw: "Ø4.00", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, itemRef: "SO26-08134 (4)" },
  ];
  const { body } = buildMaterialEmail("RFQ SO26-08134", items);

  it("uses numbered lines with X separators, not a padded table", () => {
    expect(body).toContain("1. SS 304 2.0 X 3.0 X 5.0 = 3 PCS");
    expect(body).not.toMatch(/ {3,}Material Type/);
  });
  it("preserves brackets and Ø verbatim", () => {
    expect(body).toContain("Ø4.00");
    expect(body).toContain("(3.50)");
  });
  it("keeps the legend, payment term and signature", () => {
    expect(body).toContain("*(00.00) = order size in mm");
    expect(body).toContain("Payment Term:");
    expect(body).toContain("http://helixpoint.com.my");
  });
  it("includes the per-item ref", () => {
    expect(body).toContain("Ref: SO26-08134 (1)");
  });
  it("general RFQs use description lines", () => {
    const g = buildGeneralEmail("RFQ Carbide", [
      { description: "Carbide Tap Mill 2.500mm X 3.30mm", qty: 3, itemRef: "SO26-01101" },
    ]);
    expect(g.body).toContain("1. Carbide Tap Mill 2.500mm X 3.30mm = 3 PCS   Ref: SO26-01101");
  });
  it("gmail compose URL carries to/su/body", () => {
    const url = gmailComposeUrl(["a@x.com", "b@y.com"], "RFQ Test", "Hello Ø");
    expect(url).toContain("mail.google.com");
    expect(url).toContain("to=a%40x.com%2Cb%40y.com");
    expect(url).toContain("body=Hello+%C3%98");
  });
});

describe("analyseQuotes — the workbook's comparison scenario", () => {
  const inquiry: InquiryItem[] = [
    { id: "i1", materialType: "SS 304", thicknessRaw: "2.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, itemRef: "" },
    { id: "i2", materialType: "SS304", thicknessRaw: "(4.00)", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, itemRef: "" },
    { id: "i3", materialType: "5051", thicknessRaw: "5.0", heightRaw: "6.0", lengthRaw: "7.0", qty: 5, itemRef: "" },
  ];
  const line = (id: string, price: number, over: Partial<{ t: string; h: string; l: string; qty: number | null }> = {}) => ({
    rfqItemId: id,
    thicknessRaw: over.t ?? inquiry.find((x) => x.id === id)!.thicknessRaw,
    heightRaw: over.h ?? inquiry.find((x) => x.id === id)!.heightRaw,
    lengthRaw: over.l ?? inquiry.find((x) => x.id === id)!.lengthRaw,
    qty: over.qty === undefined ? inquiry.find((x) => x.id === id)!.qty : over.qty,
    price,
    notes: "",
  });

  const quotes = [
    { supplierName: "AXXX", notes: "Ex-stock", items: [line("i1", 25, { t: "3.0" }), line("i2", 16.38), line("i3", 11.1, { h: "8.0" })] },
    { supplierName: "BXXX", notes: "", items: [line("i1", 22.5), line("i2", 15.3), line("i3", 13.3)] },
    { supplierName: "CXXX", notes: "No stock for item 2", items: [line("i1", 21.25, { t: "2.5", h: "3.5" }), line("i3", 13.0, { h: "6.5" })] },
  ];
  const result = analyseQuotes(inquiry, quotes);

  it("detects off-spec on any dimension, not just thickness", () => {
    const a = result.suppliers[0];
    expect(a.items[0].thicknessOk).toBe(false);
    expect(a.items[2].heightOk).toBe(false);
    expect(a.fullSpec).toBe(false);
  });
  it("handles partial coverage (skipped items)", () => {
    const c = result.suppliers[2];
    expect(c.quotedCount).toBe(2);
    expect(c.fullCoverage).toBe(false);
    expect(c.items[1].quoted).toBeNull();
  });
  it("recommends the full-coverage full-spec supplier", () => {
    expect(result.recommended?.supplierName).toBe("BXXX");
  });
  it("totals only over quoted items", () => {
    expect(result.suppliers[2].total).toBeCloseTo(21.25 * 3 + 13.0 * 5, 2);
  });
});

describe("analyseQuotes — wrong-money regressions", () => {
  const base: InquiryItem = {
    id: "i1", materialType: "SS 304", thicknessRaw: "2", heightRaw: "3", lengthRaw: "5",
    qty: 3, itemRef: "",
  };
  const mk = (name: string, price: number, qty: number | null, itemQty: number | null = qty) => ({
    supplierName: name, notes: "",
    items: [{ rfqItemId: "i1", thicknessRaw: "2", heightRaw: "3", lengthRaw: "5", qty: itemQty, price, notes: "" }],
  });

  it("a missing quantity does NOT price the line at zero and win the award", () => {
    const inquiry = [{ ...base, qty: null }];
    const r = analyseQuotes(inquiry, [mk("NoQty", 5, null, null), mk("Real", 20, 3, 3)]);
    expect(r.recommended?.supplierName).toBe("Real");
    const noQty = r.suppliers.find((s) => s.supplierName === "NoQty")!;
    expect(noQty.total).toBe(0);
    expect(noQty.pricedCount).toBe(0);
    expect(noQty.issues.join(" ")).toMatch(/no quantity/i);
  });

  it("prices at the quantity the supplier quoted, not the inquiry's", () => {
    const r = analyseQuotes([base], [mk("MOQ", 2, 500, 500)]);
    // 500 pcs at RM2, not 3 pcs at RM2
    expect(r.suppliers[0].total).toBeCloseTo(1000, 2);
    expect(r.suppliers[0].items[0].qtyOk).toBe(false);
  });

  it("suppresses RM/kg on a mixed basket instead of inflating it", () => {
    const inquiry: InquiryItem[] = [
      { ...base, id: "s", materialType: "SS 304" },
      { ...base, id: "p", materialType: "PEEK" },
    ];
    const q = {
      supplierName: "Mixed", notes: "",
      items: ["s", "p"].map((id) => ({
        rfqItemId: id, thicknessRaw: "2", heightRaw: "3", lengthRaw: "5", qty: 3, price: 10, notes: "",
      })),
    };
    const r = analyseQuotes(inquiry, [q]);
    expect(r.suppliers[0].weightIncomplete).toBe(true);
    expect(r.suppliers[0].rmPerKg).toBeNull();
    expect(r.rankedBy).toBe("total");
  });

  it("never ranks RM/kg against RM-per-line in one comparison", () => {
    // One weighable supplier, one all-plastic: must fall back to total RM.
    const inquiry: InquiryItem[] = [{ ...base, materialType: "PEEK" }];
    const r = analyseQuotes(inquiry, [mk("A", 30, 3), mk("B", 10, 3)]);
    expect(r.rankedBy).toBe("total");
    expect(r.recommended?.supplierName).toBe("B");
  });

  it("byRmPerKg is stable when neither side has RM/kg", () => {
    const inquiry: InquiryItem[] = [{ ...base, materialType: "PEEK" }];
    const r = analyseQuotes(inquiry, [mk("A", 30, 3), mk("B", 10, 3)]);
    const sorted = r.suppliers.slice().sort(byRmPerKg);
    expect(sorted.map((s) => s.supplierName)).toEqual(["B", "A"]);
    expect(byRmPerKg(r.suppliers[0], r.suppliers[1])).not.toBeNaN();
  });

  it("reports nothing comparable rather than inventing a winner", () => {
    const r = analyseQuotes([{ ...base, qty: null }], [mk("X", 5, null, null)]);
    expect(r.recommended).toBeNull();
    expect(r.rankedBy).toBeNull();
  });
});

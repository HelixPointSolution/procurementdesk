import { describe, it, expect } from "vitest";
import { parseDim, dimsMatch, isRoundItem } from "../dimensions";
import { densityFor, pieceWeightKg, looksLikeRoundStock } from "../weight";
import { suggestSuppliers, type MaterialGroup } from "../supplierMatch";
import {
  buildMaterialEmail, buildGeneralEmail, gmailComposeUrl, mailtoUrl, ensureRfqPrefix,
} from "../email";
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

  it("a zero dimension means NOT weighable — never 0 kg (client's RM 250/kg bug)", () => {
    // Entered exactly as in their screenshot: diameter in Thickness, no Ø.
    expect(pieceWeightKg({ materialType: "ALU 6061 ROD", thicknessRaw: "127.00", heightRaw: "0.00", lengthRaw: "36.00" }))
      .toBeNull();
    expect(pieceWeightKg({ materialType: "SS 304", thicknessRaw: "0", heightRaw: "50", lengthRaw: "200" }))
      .toBeNull();
    // Round path too: Ø with a zero length is not weighable.
    expect(pieceWeightKg({ materialType: "440C", thicknessRaw: "Ø50", heightRaw: "", lengthRaw: "0.00" }))
      .toBeNull();
  });

  it("looksLikeRoundStock flags ROD/BAR/SHAFT names missing a Ø", () => {
    expect(looksLikeRoundStock("ALU 6061 ROD", "127.00", "0.00", "36.00")).toBe(true);
    expect(looksLikeRoundStock("ALU 6061 ROD", "Ø127.00", "", "36.00")).toBe(false);
    expect(looksLikeRoundStock("SS 304", "2.0", "3.0", "5.0")).toBe(false);
  });
});

describe("analyseQuotes — client screenshot regression (RM 250/kg for aluminium)", () => {
  // RFQ "6061 PLATE; ref: SO26-08453 (5)(6)", supplier BXXX Sdn Bhd, 20 Aug.
  const inquiry: InquiryItem[] = [
    { id: "p", materialType: "ALU 6061 PLATE", thicknessRaw: "(3.00)", heightRaw: "(122.00)", lengthRaw: "(122.00)", qty: 200, itemRef: "SO26-08453 (5)" },
    { id: "r", materialType: "ALU 6061 ROD", thicknessRaw: "(127.00)", heightRaw: "0.00", lengthRaw: "(36.00)", qty: 100, itemRef: "SO26-08453 (6)" },
  ];
  const r = analyseQuotes(inquiry, [{
    supplierName: "BXXX Sdn Bhd", notes: "",
    items: [
      { rfqItemId: "p", thicknessRaw: "(3.00)", heightRaw: "(122.00)", lengthRaw: "(122.00)", qty: 200, price: 22.5, notes: "" },
      { rfqItemId: "r", thicknessRaw: "(127.00)", heightRaw: "0.00", lengthRaw: "(36.00)", qty: 100, price: 15.3, notes: "" },
    ],
  }]);
  const s = r.suppliers[0];

  it("total RM still counts every priced line", () => {
    expect(s.total).toBeCloseTo(6030, 2);
  });
  it("RM/kg is suppressed instead of showing 250.08", () => {
    // Before the fix: rod weighed 0 kg, total kg 24.112, RM/kg 250.08 shown.
    expect(s.weightIncomplete).toBe(true);
    expect(s.rmPerKg).toBeNull();
    expect(s.issues.join(" ")).toMatch(/no computable weight/i);
  });
  it("ranking falls back to total RM, honestly labelled", () => {
    expect(r.rankedBy).toBe("total");
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

  // Client, 25 Aug: "只要有6061，它就要出來" — anything containing 6061 must hit
  // the 6061 suppliers, with or without "Alu", with or without a form word.
  it("'6061 flat bar' finds the ALU 6061 group (regression)", () => {
    expect(suggestSuppliers("6061 flat bar", GROUPS)[0]?.name).toBe("YanKong");
    expect(suggestSuppliers("6061 FLAT BAR", GROUPS)[0]?.name).toBe("YanKong");
    expect(suggestSuppliers("6061 plate", GROUPS)[0]?.name).toBe("YanKong");
    expect(suggestSuppliers("6061", GROUPS)[0]?.name).toBe("YanKong");
  });
  it("short generic tokens do not match everything", () => {
    expect(suggestSuppliers("MS", GROUPS)).toEqual([]);
    expect(suggestSuppliers("BAR", GROUPS)).toEqual([]);
  });
});

describe("email — v1 numbered lines + 20 Aug client feedback", () => {
  const items = [
    { materialType: "SS 304", thicknessRaw: "2.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, itemRef: "SO26-08134 (1)" },
    { materialType: "SS304", thicknessRaw: "Ø4.00", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, itemRef: "SO26-08134 (4)" },
  ];
  const em = buildMaterialEmail("SO26-08134", items);

  it("subject auto-gains the RFQ prefix, without doubling", () => {
    expect(em.subject).toBe("RFQ SO26-08134");
    expect(ensureRfqPrefix("RFQ 6061 PLATE")).toBe("RFQ 6061 PLATE");
    expect(ensureRfqPrefix("rfq lower")).toBe("rfq lower");
    expect(ensureRfqPrefix("6061 PLATE")).toBe("RFQ 6061 PLATE");
  });
  it("uses numbered lines with X separators, not a padded table", () => {
    expect(em.bodyForMail).toContain("1. SS 304 2.0 X 3.0 X 5.0 = 3 PCS");
    expect(em.bodyForMail).not.toMatch(/ {3,}Material Type/);
  });
  it("preserves brackets and Ø verbatim", () => {
    expect(em.bodyForMail).toContain("Ø4.00");
    expect(em.bodyForMail).toContain("(3.50)");
  });
  it("frames the legend with horizontal rules", () => {
    const rule = "-".repeat(46);
    const idx = em.bodyForMail.indexOf("Please quote for the following:");
    expect(em.bodyForMail.lastIndexOf(rule, idx)).toBeGreaterThan(-1);
    expect(em.bodyForMail.indexOf(rule, idx)).toBeGreaterThan(idx);
  });
  it("wraps the per-item ref in brackets", () => {
    expect(em.bodyForMail).toContain("(Ref: SO26-08134 (1))");
  });
  it("omits blank and zero dims — the client's rod line", () => {
    const rod = buildMaterialEmail("x", [
      { materialType: "ALU 6061 ROD", thicknessRaw: "127.00", heightRaw: "0.00", lengthRaw: "36.00", qty: 100, itemRef: "SO26-08453 (6)" },
    ]);
    expect(rod.bodyForMail).toContain("1. ALU 6061 ROD 127.00 X 36.00 = 100 PCS");
    expect(rod.bodyForMail).not.toContain("0.00 X");
  });
  it("Copy body omits the signature; mail body includes it", () => {
    expect(em.bodyForMail).toContain("Mobile: 011-5950 1559");
    expect(em.bodyForMail).toContain("http://helixpoint.com.my");
    expect(em.bodyForCopy).not.toContain("Mobile: 011-5950 1559");
    expect(em.bodyForCopy).not.toContain("http://helixpoint.com.my");
    expect(em.bodyForCopy).toContain("Payment Term:");
    expect(em.bodyForCopy).toContain("Thank you.");
  });
  it("general RFQs use description lines and bracketed refs", () => {
    const g = buildGeneralEmail("Carbide", [
      { description: "Carbide Tap Mill 2.500mm X 3.30mm", qty: 3, itemRef: "SO26-01101" },
    ]);
    expect(g.subject).toBe("RFQ Carbide");
    expect(g.bodyForMail).toContain("1. Carbide Tap Mill 2.500mm X 3.30mm = 3 PCS   (Ref: SO26-01101)");
    expect(g.bodyForCopy).not.toContain("Mobile:");
  });
  it("gmail compose URL puts recipients in BCC, never to", () => {
    const url = gmailComposeUrl(["a@x.com", "b@y.com"], "RFQ Test", "Hello Ø");
    expect(url).toContain("mail.google.com");
    expect(url).toContain("bcc=a%40x.com%2Cb%40y.com");
    expect(url).not.toContain("to=");
    expect(url).toContain("body=Hello+%C3%98");
  });
  it("mailto URL uses bcc with an empty to", () => {
    const url = mailtoUrl(["a@x.com"], "S", "B");
    expect(url.startsWith("mailto:?bcc=")).toBe(true);
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

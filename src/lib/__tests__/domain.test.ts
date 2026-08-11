import { describe, it, expect } from "vitest";
import { parseDim, dimsMatch, isRoundItem } from "../dimensions";
import { densityFor, pieceWeightKg } from "../weight";
import { suggestSuppliers, type MaterialGroup } from "../supplierMatch";
import { buildMaterialEmail, gmailComposeUrl } from "../email";
import { analyseQuotes, type InquiryItem } from "../compare";

describe("parseDim — Excel notation rules", () => {
  it("parses plain numbers (finishing size)", () => {
    expect(parseDim("2.0")).toMatchObject({ value: 2, isBracket: false, isDiameter: false });
  });
  it("parses bracket notation (order size) — note1: calc same with or without", () => {
    expect(parseDim("(9.50)")).toMatchObject({ value: 9.5, isBracket: true });
    expect(parseDim("(3.50)")!.value).toBe(3.5);
  });
  it("parses Ø diameters — note2: calc same, symbol must survive", () => {
    const d = parseDim("Ø4.00")!;
    expect(d.value).toBe(4);
    expect(d.isDiameter).toBe(true);
    expect(d.raw).toBe("Ø4.00"); // raw preserved for the email
  });
  it("handles blanks and junk", () => {
    expect(parseDim("")).toBeNull();
    expect(parseDim(null)).toBeNull();
    expect(parseDim("abc")).toBeNull();
  });
  it("dimsMatch ignores notation, compares values", () => {
    expect(dimsMatch("(4.00)", "4.0")).toBe(true);
    expect(dimsMatch("Ø4.00", "4")).toBe(true);
    expect(dimsMatch("2.0", "3.0")).toBe(false); // the Excel's off-spec example
  });
  it("isRoundItem detects Ø in any dim", () => {
    expect(isRoundItem("Ø4.00", "5.0", "(3.50)")).toBe(true);
    expect(isRoundItem("2.0", "3.0", "5.0")).toBe(false);
  });
});

describe("weight — Excel formulas F69/F72", () => {
  it("rectangular: 20 × 50 × 200 steel = 1.6 kg (Excel's own example)", () => {
    const kg = pieceWeightKg({
      materialType: "SS 304",
      thicknessRaw: "20",
      heightRaw: "50",
      lengthRaw: "200",
    });
    expect(kg).toBeCloseTo(1.6, 3);
  });
  it("round: Ø50 × 200 steel = 3.3 kg (Excel's example says 303 — decimal typo)", () => {
    const kg = pieceWeightKg({
      materialType: "440C",
      thicknessRaw: "Ø50",
      heightRaw: "",
      lengthRaw: "200",
    });
    expect(kg).toBeCloseTo(50 * 50 * 200 * 0.0000066, 6); // 3.3 kg
    expect(kg).toBeCloseTo(3.3, 1);
  });
  it("aluminium scales by density (2.7 vs 8.0)", () => {
    const alu = pieceWeightKg({ materialType: "Alu 6061", thicknessRaw: "20", heightRaw: "50", lengthRaw: "200" })!;
    expect(alu).toBeCloseTo(1.6 * (2.7 / 8.0), 3);
  });
  it("plastics have no meaningful RM/kg", () => {
    expect(densityFor("PEEK")).toBeNull();
    expect(pieceWeightKg({ materialType: "TEFLON", thicknessRaw: "20", heightRaw: "50", lengthRaw: "200" })).toBeNull();
  });
  it("unknown material defaults to the Excel steel constant", () => {
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
      { name: "Three & Three", email: "tthpgbm@kssc.com.my" },
      { name: "Lian Giap", email: "wcgoh@liangiap.com.my" },
    ],
  },
  {
    category: "ALLOY STEEL",
    materials: "440C, SS400, STAVAX, SUS420J2",
    suppliers: [{ name: "Wong Tool", email: "wongtoolsteel@gmail.com" }],
  },
];

describe("supplierMatch — normalisation + aliases", () => {
  it("'SS 304' finds the SUS 304 group, top 3 in list order", () => {
    const s = suggestSuppliers("SS 304", GROUPS);
    expect(s.map((x) => x.name)).toEqual(["Beye", "PHH", "Heap Sing Huat"]);
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

describe("email generation", () => {
  const items = [
    { materialType: "SS 304", thicknessRaw: "2.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, itemRef: "SO26-08134 (1)" },
    { materialType: "SS304", thicknessRaw: "Ø4.00", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, itemRef: "SO26-08134 (4)" },
  ];
  it("preserves brackets and Ø verbatim in the body", () => {
    const { body } = buildMaterialEmail("RFQ SO26-08134", items);
    expect(body).toContain("Ø4.00");
    expect(body).toContain("(3.50)");
    expect(body).toContain("*(00.00) = order size in mm");
    expect(body).toContain("Payment Term:");
    expect(body).toContain("http://helixpoint.com.my");
  });
  it("gmail compose URL carries to/su/body", () => {
    const url = gmailComposeUrl(["a@x.com", "b@y.com"], "RFQ Test", "Hello Ø");
    expect(url).toContain("mail.google.com");
    expect(url).toContain("to=a%40x.com%2Cb%40y.com");
    // URLSearchParams uses form-encoding: space → "+", Ø → %C3%98
    expect(url).toContain("body=Hello+%C3%98");
  });
});

describe("analyseQuotes — the Excel comparison scenario", () => {
  const inquiry: InquiryItem[] = [
    { id: "i1", materialType: "SS 304", thicknessRaw: "2.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, itemRef: "" },
    { id: "i2", materialType: "SS304", thicknessRaw: "(4.00)", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, itemRef: "" },
    { id: "i3", materialType: "5051", thicknessRaw: "5.0", heightRaw: "6.0", lengthRaw: "7.0", qty: 5, itemRef: "" },
  ];
  const quotes = [
    {
      supplierName: "AXXX Sdn Bhd",
      notes: "Ex-stock, valid till tomorrow",
      items: [
        // off-spec: quoted thickness 3.0 vs asked 2.0
        { rfqItemId: "i1", thicknessRaw: "3.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, price: 25, notes: "" },
        { rfqItemId: "i2", thicknessRaw: "(4.00)", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, price: 16.38, notes: "" },
        // off-spec: quoted height 8.0 vs asked 6.0
        { rfqItemId: "i3", thicknessRaw: "5.0", heightRaw: "8.0", lengthRaw: "7.0", qty: 5, price: 11.1, notes: "Quoted 3mm" },
      ],
    },
    {
      supplierName: "BXXX Sdn Bhd",
      notes: "No stock for item 4, 5",
      items: [
        { rfqItemId: "i1", thicknessRaw: "2.0", heightRaw: "3.0", lengthRaw: "5.0", qty: 3, price: 22.5, notes: "" },
        { rfqItemId: "i2", thicknessRaw: "(4.00)", heightRaw: "5.0", lengthRaw: "(3.50)", qty: 2, price: 15.3, notes: "" },
        { rfqItemId: "i3", thicknessRaw: "5.0", heightRaw: "6.0", lengthRaw: "7.0", qty: 5, price: 13.3, notes: "" },
      ],
    },
    {
      supplierName: "CXXX Sdn Bhd",
      notes: "No stock for item 2",
      items: [
        // partial coverage: item 2 missing entirely
        { rfqItemId: "i1", thicknessRaw: "2.5", heightRaw: "3.5", lengthRaw: "5.0", qty: 3, price: 21.25, notes: "" },
        { rfqItemId: "i3", thicknessRaw: "5.0", heightRaw: "6.5", lengthRaw: "7.0", qty: 5, price: 13.0, notes: "" },
      ],
    },
  ];

  const result = analyseQuotes(inquiry, quotes);

  it("detects off-spec on any dimension, not just thickness", () => {
    const a = result.suppliers[0];
    expect(a.items[0].thicknessOk).toBe(false); // 3.0 vs 2.0
    expect(a.items[2].heightOk).toBe(false); // 8.0 vs 6.0 — old app missed this
    expect(a.fullSpec).toBe(false);
  });
  it("handles partial coverage (skipped items)", () => {
    const c = result.suppliers[2];
    expect(c.quotedCount).toBe(2);
    expect(c.fullCoverage).toBe(false);
    expect(c.items[1].quoted).toBeNull();
  });
  it("recommends the full-coverage full-spec supplier", () => {
    expect(result.recommended?.supplierName).toBe("BXXX Sdn Bhd");
    expect(result.reasoning).toContain("Off-spec");
  });
  it("totals only over quoted items", () => {
    const c = result.suppliers[2];
    expect(c.total).toBeCloseTo(21.25 * 3 + 13.0 * 5, 2);
  });
});

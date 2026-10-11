import { describe, it, expect } from "vitest";
import {
  buildExtractionPrompt, mapExtraction, uniqueSupplierName, nameFromFilename,
  EXTRACTION_SCHEMA, type Extraction, type ExtractionRfqItem,
} from "../extract";

// The client's own RFQ from the 25 Sep screenshot: MS and STAVAX.
const ITEMS: ExtractionRfqItem[] = [
  { materialType: "MS", description: "", thicknessRaw: "13.00", heightRaw: "20.30", lengthRaw: "(150.0)", qty: 500, itemRef: "SO26-09001 (1)" },
  { materialType: "STAVAX", description: "", thicknessRaw: "8.00", heightRaw: "18.00", lengthRaw: "(130.0)", qty: 400, itemRef: "SO26-09001 (2)" },
];

const line = (over: Partial<Extraction["lines"][number]>): Extraction["lines"][number] => ({
  item_number: 1, description: "", material: "", thickness: "", height: "", length: "",
  qty: "", unit_price: "", line_note: "", ...over,
});

describe("buildExtractionPrompt", () => {
  const p = buildExtractionPrompt(ITEMS, true);
  it("numbers the RFQ items with material, size, qty and ref", () => {
    expect(p).toContain("1. MS 13.00 x 20.30 x (150.0) — qty 500 (ref SO26-09001 (1))");
    expect(p).toContain("2. STAVAX 8.00 x 18.00 x (130.0) — qty 400");
  });
  it("explains the bracket / Ø notation for material RFQs only", () => {
    expect(p).toContain("Ø");
    expect(buildExtractionPrompt(ITEMS, false)).not.toContain("order size");
  });
  it("forbids guessing per-piece prices from per-kg rates", () => {
    expect(p).toMatch(/per kg/i);
    expect(p).toMatch(/never guess/i);
  });
});

describe("EXTRACTION_SCHEMA", () => {
  it("is strict-compatible: every object closes and requires all its keys", () => {
    const check = (node: Record<string, unknown>) => {
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect([...(node.required as string[])].sort())
          .toEqual(Object.keys(node.properties as object).sort());
        Object.values(node.properties as Record<string, Record<string, unknown>>).forEach(check);
      }
      if (node.type === "array") check(node.items as Record<string, unknown>);
    };
    check(EXTRACTION_SCHEMA as unknown as Record<string, unknown>);
  });
});

describe("mapExtraction", () => {
  it("aligns lines to RFQ items by item_number, not by order", () => {
    const m = mapExtraction({
      supplier_name: "AXXX Sdn Bhd", currency: "RM", notes: "Ex-stock",
      lines: [
        line({ item_number: 2, unit_price: "16.38", qty: "400" }),
        line({ item_number: 1, unit_price: "25", qty: "500", thickness: "3.0" }),
      ],
    }, ITEMS, "file");
    expect(m.supplierName).toBe("AXXX Sdn Bhd");
    // Height was not stated by the supplier: stays blank, never copied from the RFQ.
    expect(m.lines[0]).toMatchObject({ quoted: true, price: "25", thicknessRaw: "3.0", heightRaw: "" });
    expect(m.lines[1]).toMatchObject({ quoted: true, price: "16.38" });
    expect(m.warnings).toEqual([]);
  });

  it("leaves an unpriced line unticked and keeps its reason on the supplier", () => {
    const m = mapExtraction({
      supplier_name: "CXXX", currency: "RM", notes: "",
      lines: [line({ item_number: 1, unit_price: "21.25" }), line({ item_number: 2, line_note: "No stock" })],
    }, ITEMS, "file");
    expect(m.lines[1].quoted).toBe(false);
    expect(m.notes).toContain("Item 2: No stock");
  });

  it("marks an item the supplier never mentioned as not quoted, with nothing pre-filled", () => {
    const m = mapExtraction({
      supplier_name: "BXXX", currency: "RM", notes: "", lines: [line({ item_number: 1, unit_price: "22.5" })],
    }, ITEMS, "file");
    // Client, 25 Sep: sizes must never be auto-filled from the RFQ.
    expect(m.lines[1]).toMatchObject({ quoted: false, price: "", thicknessRaw: "", heightRaw: "", qty: "" });
  });

  it("keeps the supplier's own sizes even when they differ from the RFQ", () => {
    const m = mapExtraction({
      supplier_name: "X", currency: "RM", notes: "",
      lines: [line({ item_number: 1, unit_price: "9.5", thickness: "18.00", height: "26.00", length: "150.00" })],
    }, ITEMS, "file");
    expect(m.lines[0]).toMatchObject({ thicknessRaw: "18.00", heightRaw: "26.00", lengthRaw: "150.00" });
  });

  it("notes a substituted grade, but not an obvious match", () => {
    const m = mapExtraction({
      supplier_name: "ASCO", currency: "RM", notes: "",
      lines: [
        line({ item_number: 1, unit_price: "15", material: "MS/S275JR" }),
        line({ item_number: 2, unit_price: "24", material: "1.2083" }),
      ],
    }, ITEMS, "file");
    expect(m.lines[0].notes).not.toMatch(/Offered/);
    expect(m.lines[1].notes).toContain("Offered 1.2083");
  });

  it("does not repeat the grade when the supplier note already names it", () => {
    const m = mapExtraction({
      supplier_name: "WONG", currency: "RM", notes: "",
      lines: [line({ item_number: 2, unit_price: "13.4", material: "SUS420J2", line_note: "Offered SUS420J2 for STAVAX." })],
    }, ITEMS, "file");
    expect(m.lines[1].notes).toBe("Offered SUS420J2 for STAVAX.");
  });

  it("parses prices with thousands separators", () => {
    const m = mapExtraction({
      supplier_name: "X", currency: "RM", notes: "", lines: [line({ item_number: 1, unit_price: "1,250.00" })],
    }, ITEMS, "file");
    expect(m.lines[0].price).toBe("1250");
  });

  it("warns on a foreign currency instead of silently summing it as RM", () => {
    const m = mapExtraction({
      supplier_name: "AMS Light Metal", currency: "SGD", notes: "",
      lines: [line({ item_number: 1, unit_price: "9.10" })],
    }, ITEMS, "file");
    expect(m.warnings.join(" ")).toMatch(/SGD/);
    expect(m.notes).toContain("Prices in SGD");
  });

  it("treats MYR / RM as home currency", () => {
    for (const c of ["RM", "MYR", "myr", ""]) {
      const m = mapExtraction({ supplier_name: "X", currency: c, notes: "", lines: [line({ unit_price: "1" })] }, ITEMS, "f");
      expect(m.warnings.join(" ")).not.toMatch(/not RM/);
    }
  });

  it("reports lines that match no RFQ item", () => {
    const m = mapExtraction({
      supplier_name: "X", currency: "RM", notes: "",
      lines: [line({ item_number: 1, unit_price: "5" }), line({ item_number: 0, description: "Cutting charge", unit_price: "30" })],
    }, ITEMS, "file");
    expect(m.warnings.join(" ")).toMatch(/Cutting charge/);
  });

  it("prefers a priced line when two lines claim the same item", () => {
    const m = mapExtraction({
      supplier_name: "X", currency: "RM", notes: "",
      lines: [line({ item_number: 1, line_note: "alt size, no price" }), line({ item_number: 1, unit_price: "18" })],
    }, ITEMS, "file");
    expect(m.lines[0]).toMatchObject({ quoted: true, price: "18" });
  });

  it("falls back to the file name and warns when nothing was priced", () => {
    const m = mapExtraction({ supplier_name: "", currency: "", notes: "", lines: [] }, ITEMS, "Q26091224");
    expect(m.supplierName).toBe("Q26091224");
    expect(m.warnings.join(" ")).toMatch(/No prices/);
  });
});

describe("naming helpers", () => {
  it("makes supplier names unique, case-insensitively", () => {
    expect(uniqueSupplierName("Lian Giap", ["Twin Metal"])).toBe("Lian Giap");
    expect(uniqueSupplierName("Lian Giap", ["lian giap"])).toBe("Lian Giap (2)");
    expect(uniqueSupplierName("Lian Giap", ["Lian Giap", "Lian Giap (2)"])).toBe("Lian Giap (3)");
  });
  it("derives a name from the file", () => {
    expect(nameFromFilename("HELIX POINT QT 2609 159.pdf")).toBe("HELIX POINT QT 2609 159");
    expect(nameFromFilename("Q26091224.pdf")).toBe("Q26091224");
  });
});

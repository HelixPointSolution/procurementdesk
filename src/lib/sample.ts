/* "Load example" data — the sample job from the client's spec workbook.
 *
 * v1 shipped with a real job preloaded, which is what made it immediately
 * understandable. Here it is behind a button instead, so a real RFQ is never
 * silently polluted with demo figures.
 */

export const SAMPLE_MATERIAL_SUBJECT = "RFQ SO26-08134";
export const SAMPLE_GENERAL_SUBJECT = "RFQ Carbide Tap Mill";

export interface SampleMaterialItem {
  materialType: string;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: string;
  itemRef: string;
}

/** Includes the bracket and Ø notations deliberately — they must survive to the email. */
export const SAMPLE_MATERIAL_ITEMS: SampleMaterialItem[] = [
  { materialType: "SS 304",   thicknessRaw: "2.0",    heightRaw: "3.0",    lengthRaw: "5.0",    qty: "3", itemRef: "SO26-08134 (1)" },
  { materialType: "SS304",    thicknessRaw: "Ø4.00",  heightRaw: "5.0",    lengthRaw: "(3.50)", qty: "2", itemRef: "SO26-08134 (4)" },
  { materialType: "5051",     thicknessRaw: "5.0",    heightRaw: "6.0",    lengthRaw: "7.0",    qty: "5", itemRef: "SO26-08134 (5)" },
  { materialType: "440C",     thicknessRaw: "(7.60)", heightRaw: "(9.50)", lengthRaw: "5.0",    qty: "5", itemRef: "" },
  { materialType: "Alu 6061", thicknessRaw: "10.0",   heightRaw: "Ø4.00",  lengthRaw: "6.0",    qty: "1", itemRef: "SO26-07075 (2)" },
];

export const SAMPLE_GENERAL_ITEMS = [
  { description: "Carbide Tap Mill 2.500mm X 3.30mm", qty: "3", itemRef: "SO26-01101" },
];

/** Sample supplier quotes, including an off-spec quote and a skipped item. */
export interface SampleQuote {
  supplierName: string;
  notes: string;
  /** Per inquiry item index: null = not quoted (no stock). */
  lines: Array<{ thicknessRaw?: string; heightRaw?: string; lengthRaw?: string; price: string } | null>;
}

export const SAMPLE_MATERIAL_QUOTES: SampleQuote[] = [
  {
    supplierName: "AXXX Sdn Bhd",
    notes: "Ex-stock, valid till tomorrow",
    lines: [
      { thicknessRaw: "3.0", price: "25.00" }, // off-spec: asked 2.0
      { price: "16.38" },
      { heightRaw: "8.0", price: "11.10" },    // off-spec: asked 6.0
      { price: "18.00" },
      { price: "9.50" },
    ],
  },
  {
    supplierName: "BXXX Sdn Bhd",
    notes: "",
    lines: [
      { price: "22.50" },
      { price: "15.30" },
      { price: "13.30" },
      { price: "17.20" },
      { price: "9.10" },
    ],
  },
  {
    supplierName: "CXXX Sdn Bhd",
    notes: "No stock for item 2",
    lines: [
      { price: "21.25" },
      null,                                     // skipped entirely
      { price: "13.00" },
      { price: "16.80" },
      { price: "8.90" },
    ],
  },
];

export const SAMPLE_GENERAL_QUOTES: SampleQuote[] = [
  { supplierName: "Dxxx Sdn Bhd", notes: "Delivery 1 week", lines: [{ price: "75.00" }] },
  { supplierName: "Exxx Sdn Bhd", notes: "Ex-stock",        lines: [{ price: "80.00" }] },
];

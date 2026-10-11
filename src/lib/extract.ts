/* Supplier-quotation extraction — the pure half.
 *
 * The client asked (25 Sep 2026) for the Compare tab to work like this:
 * upload the 2–3 suppliers' quotations, and compare. No typing grids up front.
 * The route handler (src/app/api/extract-quote/route.ts) sends the file to
 * Claude with EXTRACTION_SCHEMA; this module builds the prompt and turns the
 * model's answer into the quote-card shape CompareEditor already persists.
 *
 * Everything here is deterministic and unit-tested; nothing calls the network.
 */

import { parsePrice, parseQty } from "./num";

/** One RFQ line the supplier was asked to quote, as the prompt presents it. */
export interface ExtractionRfqItem {
  materialType: string;
  description: string;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: number | null;
  itemRef: string;
}

/** What the model returns (mirrors EXTRACTION_SCHEMA). */
export interface ExtractionLine {
  /** 1-based RFQ item this line answers; 0 when it matches none. */
  item_number: number;
  description: string;
  /** Grade the supplier offered, e.g. "S275JR", "1.2083". */
  material: string;
  thickness: string;
  height: string;
  length: string;
  qty: string;
  unit_price: string;
  line_note: string;
}

export interface Extraction {
  supplier_name: string;
  currency: string;
  notes: string;
  lines: ExtractionLine[];
}

/** Every field required and no nulls — unknown values come back as "" (or
 *  item_number 0), which keeps the schema valid under strict structured
 *  outputs and keeps the mapping below free of null handling. */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supplier_name", "currency", "notes", "lines"],
  properties: {
    supplier_name: {
      type: "string",
      description: "Company that issued the quotation (from letterhead or signature). Empty if not shown.",
    },
    currency: {
      type: "string",
      description: 'Currency of the prices as written, e.g. "RM", "MYR", "SGD", "USD". Empty if not shown.',
    },
    notes: {
      type: "string",
      description: "Short summary of terms: validity, delivery / lead time, stock status, payment terms, cutting charges, anything not quoted. Empty if none.",
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item_number", "description", "material", "thickness", "height", "length", "qty", "unit_price", "line_note"],
        properties: {
          item_number: { type: "integer", description: "1-based number of the RFQ item this line answers, 0 if it matches none." },
          description: { type: "string", description: "Material or item description as the supplier wrote it." },
          material: { type: "string", description: "Material grade the supplier is offering (e.g. S275JR, SUS420J2, 1.2083, ALU 6061). Empty for non-material items or if not shown." },
          thickness: { type: "string", description: "Finished thickness (or diameter, prefixed with Ø) as quoted. Empty for non-material items or if not shown." },
          height: { type: "string", description: "Height / width as quoted. Empty if not applicable." },
          length: { type: "string", description: "Length as quoted. Empty if not applicable." },
          qty: { type: "string", description: "Quantity quoted, digits only. Empty if not shown." },
          unit_price: { type: "string", description: "Price per piece, digits and decimal point only. Empty if the supplier did not price this line." },
          line_note: { type: "string", description: "Anything the purchaser must know about this line: substituted size, no stock, price was per kg or a lot total, etc. Empty if nothing." },
        },
      },
    },
  },
} as const;

function itemLabel(it: ExtractionRfqItem, isMaterial: boolean): string {
  if (!isMaterial) return it.description || "(no description)";
  const dims = [it.thicknessRaw, it.heightRaw, it.lengthRaw].map((d) => d.trim()).filter(Boolean);
  return [it.materialType, dims.join(" x ")].filter(Boolean).join(" ");
}

/** The instruction sent alongside the quotation file. */
export function buildExtractionPrompt(items: ExtractionRfqItem[], isMaterial: boolean): string {
  const list = items
    .map((it, i) => {
      const qty = it.qty == null ? "" : ` — qty ${it.qty}`;
      const ref = it.itemRef.trim() ? ` (ref ${it.itemRef.trim()})` : "";
      return `${i + 1}. ${itemLabel(it, isMaterial)}${qty}${ref}`;
    })
    .join("\n");

  const notation = isMaterial
    ? `\nDimensions are in mm. "(9.50)" in brackets means order size; "Ø" marks a diameter. ` +
      `Copy dimensions as the supplier wrote them, keeping any brackets or Ø.\n`
    : "\n";

  const rules = [
    `Match every quoted line to the RFQ item it answers and give that item's number. ` +
      `Match on ${isMaterial ? "material and size" : "description"}, not on line order — suppliers reorder, merge ` +
      `and skip lines. A line that answers none of our items gets item number 0.`,
    `unit_price is the full price for ONE finished piece. Suppliers often split one item across sub-lines ` +
      `(the item itself, then machining, cutting or grinding charges): add those sub-lines together, give the sum, and ` +
      `list the breakdown in line_note. If the supplier only gives a line total, divide by the quoted quantity and say ` +
      `so in line_note. If the price is per kg or per metre, leave unit_price empty and put the rate in line_note — ` +
      `never guess a per-piece figure.`,
    `qty is the number of pieces actually being quoted. The Qty column sometimes shows 1.00 while the real quantity ` +
      `sits in Remarks (for example "500 pcs") — use the real quantity. Ignore document totals that merely add up unit prices.`,
    ...(isMaterial
      ? [
          `If the supplier gives both a finish size (F/S) and an order or raw size (O/S), put the finish size in ` +
            `thickness/height/length and mention the order size in line_note.`,
          `Record sizes exactly as the supplier quoted them, never copied from our list — suppliers often change ` +
            `sizes and the purchaser needs to see what was really offered. If a size is not stated, leave it empty.`,
          `Put the material grade the supplier actually offers in material, even when it differs from ours ` +
            `(for example 1.2083 or SUS420J2 offered for STAVAX).`,
        ]
      : [`Leave material, thickness, height and length empty — these are not material items.`]),
    `If an item is marked no stock, not available, or left unpriced, include it with an empty unit_price and explain in line_note.`,
    `Use empty strings for anything the quotation does not show. Do not invent values.`,
  ];

  return (
    `The attached file is a supplier's quotation replying to our request for quotation (RFQ). ` +
    `We asked for these items:\n\n${list}\n${notation}\n` +
    `Read the quotation and fill in the structured fields.\n\n` +
    rules.map((r) => `- ${r}`).join("\n")
  );
}

export interface MappedLine {
  quoted: boolean;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: string;
  price: string;
  notes: string;
}

export interface MappedQuote {
  supplierName: string;
  notes: string;
  /** Parallel to the RFQ items. */
  lines: MappedLine[];
  /** Human-readable problems the purchaser should check before trusting the figures. */
  warnings: string[];
}

const HOME_CURRENCY = /^(rm|myr|ringgit)$/i;

/**
 * Turn the model's answer into quote-card lines aligned with the RFQ items.
 * Unmatched lines and a foreign currency are surfaced as warnings and in the
 * supplier notes rather than silently dropped or mixed into RM totals.
 */
export function mapExtraction(
  ex: Extraction,
  items: ExtractionRfqItem[],
  fallbackName: string
): MappedQuote {
  const warnings: string[] = [];
  const noteParts: string[] = [];
  if (ex.notes.trim()) noteParts.push(ex.notes.trim());

  const cur = ex.currency.trim();
  if (cur && !HOME_CURRENCY.test(cur)) {
    warnings.push(`Prices are in ${cur}, not RM — totals are compared as if they were RM.`);
    noteParts.push(`Prices in ${cur}`);
  }

  const lines: MappedLine[] = items.map((it, k) => {
    // First priced line wins when the model maps two lines to one item.
    const hits = ex.lines.filter((l) => l.item_number === k + 1);
    const hit = hits.find((l) => parsePrice(l.unit_price) != null) ?? hits[0];
    // Client, 25 Sep: "我不要它自動從RFQ那邊" — never fill a supplier's sizes
    // from our own RFQ. Suppliers change sizes, and a copied size would hide
    // that. Whatever the quotation does not state stays blank.
    if (!hit) {
      return { quoted: false, thicknessRaw: "", heightRaw: "", lengthRaw: "", qty: "", price: "", notes: "" };
    }
    const price = parsePrice(hit.unit_price);
    const qty = parseQty(hit.qty);
    const offered = hit.material.trim();
    const lineNote = hit.line_note.trim();
    // Skip our own "Offered …" when the model's note already names the grade,
    // or the card reads "Offered SUS420J2 · Offered SUS420J2 for STAVAX".
    const flagGrade = offered && !sameGrade(offered, it.materialType) &&
      !lineNote.toUpperCase().includes(offered.toUpperCase());
    const notes = [flagGrade ? `Offered ${offered}` : "", lineNote].filter(Boolean).join(" · ");
    return {
      // A line the supplier addressed but did not price stays unticked, so it
      // cannot enter the totals — its note explains why.
      quoted: price != null,
      thicknessRaw: hit.thickness.trim(),
      heightRaw: hit.height.trim(),
      lengthRaw: hit.length.trim(),
      qty: qty == null ? "" : String(qty),
      price: price == null ? "" : String(price),
      notes,
    };
  });

  // Unpriced lines are not stored as quote items, so their explanation
  // ("no stock", "per kg only") would vanish — keep it on the supplier.
  lines.forEach((l, k) => {
    if (!l.quoted && l.notes) noteParts.push(`Item ${k + 1}: ${l.notes}`);
  });

  const unmatched = ex.lines.filter((l) => l.item_number < 1 || l.item_number > items.length);
  if (unmatched.length > 0) {
    warnings.push(
      `${unmatched.length} quoted line(s) did not match any RFQ item: ` +
      unmatched.map((l) => l.description.trim() || "(no description)").join("; ")
    );
  }
  const priced = lines.filter((l) => l.quoted).length;
  if (priced === 0) warnings.push("No prices could be read for any RFQ item.");

  return {
    supplierName: ex.supplier_name.trim() || fallbackName,
    notes: noteParts.join(" · "),
    lines,
    warnings,
  };
}

/** True when the offered grade plainly is the requested one ("MS/S275JR"
 *  answering "MS"); anything else is shown to the purchaser as "Offered …". */
function sameGrade(offered: string, asked: string): boolean {
  const n = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = n(asked), o = n(offered);
  if (!a || !o) return true;
  return o.includes(a) || a.includes(o);
}

/** "Lian Giap", taken → "Lian Giap (2)". Names key the comparison, so they must be unique. */
export function uniqueSupplierName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!lower.has(name.trim().toLowerCase())) return name.trim();
  for (let n = 2; ; n++) {
    const candidate = `${name.trim()} (${n})`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** "HELIX POINT QT 2609 159.pdf" → "HELIX POINT QT 2609 159" */
export function nameFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() || "Supplier";
}

/** Media types the Claude API accepts for documents / images. */
export const EXTRACTABLE_TYPES: Record<string, "pdf" | "image"> = {
  "application/pdf": "pdf",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
};

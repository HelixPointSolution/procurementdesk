/* RFQ email generation — layout mirrors the Excel tabs "RFQ Material"
 * (rows 14–34) and "RFQ General" (rows 11–26). Dimension notation
 * ("(9.50)", "Ø4.00") is inserted verbatim — client requirement.
 */

export interface MaterialEmailItem {
  materialType: string;
  thicknessRaw: string;
  heightRaw: string;
  lengthRaw: string;
  qty: number | null;
  itemRef: string;
}

export interface GeneralEmailItem {
  description: string;
  qty: number | null;
  itemRef: string;
}

const SIGNATURE = [
  "Mobile: 011-5950 1559",
  "Helix Point Solution",
  "enquiry.helixpoint@gmail.com",
];

/** Pad columns to align in a plain-text (monospace) table. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

function qtyStr(qty: number | null): string {
  return qty == null ? "" : String(qty);
}

export function buildMaterialEmail(subject: string, items: MaterialEmailItem[]): {
  subject: string;
  body: string;
} {
  const rows = items.map((it, i) => [
    `Item ${i + 1}`,
    it.materialType,
    it.thicknessRaw,
    it.heightRaw,
    it.lengthRaw,
    qtyStr(it.qty),
    it.itemRef,
  ]);
  const body = [
    "Dear Supplier,",
    "",
    "Please quote for the following:",
    "*(00.00) = order size in mm",
    "*0.00 = Finishing size: max allowance +5mm.",
    "",
    table(["", "Material Type", "Thickness", "Height", "Length", "Qty", "Ref"], rows),
    "",
    "Payment Term:",
    "",
    "Please advise the soonest Delivery Date, and Stock availability.",
    "Thank you.",
    "",
    ...SIGNATURE,
    "http://helixpoint.com.my",
  ].join("\n");
  return { subject, body };
}

export function buildGeneralEmail(subject: string, items: GeneralEmailItem[]): {
  subject: string;
  body: string;
} {
  const rows = items.map((it, i) => [
    `Item ${i + 1}`,
    it.description,
    qtyStr(it.qty),
    it.itemRef,
  ]);
  const body = [
    "Dear Supplier,",
    "",
    "Please quote for the following:",
    "",
    table(["", "Description", "Qty", "Ref"], rows),
    "",
    "Please advise the soonest Delivery Date, and Stock availability.",
    "Thank you.",
    "",
    ...SIGNATURE,
  ].join("\n");
  return { subject, body };
}

/** Gmail compose link with To/Subject/Body pre-filled. */
export function gmailComposeUrl(to: string[], subject: string, body: string): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: to.filter(Boolean).join(","),
    su: subject,
    body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** mailto: fallback for non-Gmail default mail clients. */
export function mailtoUrl(to: string[], subject: string, body: string): string {
  const addr = to.filter(Boolean).join(",");
  return `mailto:${addr}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

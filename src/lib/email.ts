/* RFQ email generation.
 *
 * Format follows v1's numbered lines rather than a space-aligned table.
 * Padded columns only line up in a monospace font, and Gmail's compose body —
 * where these are actually sent from — is proportional, so an aligned table
 * arrives at the supplier ragged and harder to read than plain lines.
 *
 * Dimension notation ("(9.50)" order size, "Ø4.00" diameter) is inserted
 * verbatim: the client requires brackets and the Ø to survive into the email.
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

function qtyPart(qty: number | null): string {
  return qty == null ? "" : ` = ${qty} PCS`;
}

function refPart(ref: string): string {
  return ref.trim() ? `   Ref: ${ref.trim()}` : "";
}

/** "1. SS 304  (2.00) X (122.00) X (180.00) = 4 PCS   Ref: SO26-08134 (1)" */
function materialLine(it: MaterialEmailItem, i: number): string {
  const dims = [it.thicknessRaw, it.heightRaw, it.lengthRaw]
    .map((d) => d.trim())
    .filter(Boolean)
    .join(" X ");
  const material = it.materialType.trim();
  const head = [`${i + 1}.`, material, dims].filter(Boolean).join(" ");
  return `${head}${qtyPart(it.qty)}${refPart(it.itemRef)}`;
}

/** "1. Carbide Tap Mill 2.500mm X 3.30mm = 3 PCS   Ref: SO26-01101" */
function generalLine(it: GeneralEmailItem, i: number): string {
  const head = `${i + 1}. ${it.description.trim()}`;
  return `${head}${qtyPart(it.qty)}${refPart(it.itemRef)}`;
}

export function buildMaterialEmail(subject: string, items: MaterialEmailItem[]): {
  subject: string;
  body: string;
} {
  const body = [
    "Dear Supplier,",
    "",
    "Please quote for the following:",
    "*(00.00) = order size in mm",
    "*0.00 = Finishing size: max allowance +5mm.",
    "",
    ...items.map(materialLine),
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
  const body = [
    "Dear Supplier,",
    "",
    "Please quote for the following:",
    "",
    ...items.map(generalLine),
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

/**
 * Practical URL ceiling. Windows caps mailto: near 2 KB and Gmail's compose
 * URL has its own limit; past this the item list is silently truncated, so the
 * UI warns and steers the user to Copy instead.
 */
export const MAIL_URL_SAFE_LIMIT = 1800;

export function mailUrlTooLong(url: string): boolean {
  return url.length > MAIL_URL_SAFE_LIMIT;
}

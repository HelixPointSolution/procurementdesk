/* RFQ email generation.
 *
 * Format follows v1's numbered lines rather than a space-aligned table.
 * Padded columns only line up in a monospace font, and Gmail's compose body —
 * where these are actually sent from — is proportional.
 *
 * Client feedback 20 Aug 2026 baked in here:
 *  - Subject always carries the "RFQ " prefix (they hand-wrote it on the
 *    printout when it was missing).
 *  - Recipients go in BCC, never To — competing suppliers must not see each
 *    other on the same enquiry.
 *  - The legend block is framed with horizontal rules. (A real box can't
 *    survive Gmail's plain-text compose URL, and side borders misalign in
 *    proportional fonts.)
 *  - Each item's reference is wrapped in brackets: "(Ref: SO26-08453 (5))".
 *  - Two bodies per email: their Gmail auto-inserts a signature on paste, so
 *    the COPY body omits the signature block; the compose-URL body includes
 *    it because Gmail does not auto-sign URL-composed drafts.
 *  - Blank or zero dimensions are omitted from item lines (a rod entered as
 *    127.00 X 0.00 X 36.00 must not show a meaningless 0.00 to the supplier).
 *
 * Dimension notation ("(9.50)" order size, "Ø4.00" diameter) is inserted
 * verbatim: the client requires brackets and the Ø to survive into the email.
 */

import { parseDim } from "./dimensions";

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

export interface BuiltEmail {
  subject: string;
  /** For Open in Gmail / Mail app — includes the signature block. */
  bodyForMail: string;
  /** For the Copy button — no signature; their Gmail adds its own on paste. */
  bodyForCopy: string;
}

const SIGNATURE = [
  "Mobile: 011-5950 1559",
  "Helix Point Solution",
  "enquiry.helixpoint@gmail.com",
];

const RULE = "-".repeat(46);

/** Subject must always announce itself as an RFQ. */
export function ensureRfqPrefix(subject: string): string {
  const s = subject.trim();
  if (s === "") return "RFQ";
  return /^rfq\b/i.test(s) ? s : `RFQ ${s}`;
}

function qtyPart(qty: number | null): string {
  return qty == null ? "" : ` = ${qty} PCS`;
}

function refPart(ref: string): string {
  return ref.trim() ? `   (Ref: ${ref.trim()})` : "";
}

/** A dimension is shown only if it holds something meaningful — blank and
 *  zero are omitted, anything unparseable is kept verbatim (user's text). */
function visibleDim(raw: string): boolean {
  const t = raw.trim();
  if (t === "") return false;
  const p = parseDim(t);
  return p == null || p.value !== 0;
}

/** "1. ALU 6061 ROD 127.00 X 36.00 = 100 PCS   (Ref: SO26-08453 (6))" */
function materialLine(it: MaterialEmailItem, i: number): string {
  const dims = [it.thicknessRaw, it.heightRaw, it.lengthRaw]
    .map((d) => d.trim())
    .filter(visibleDim)
    .join(" X ");
  const head = [`${i + 1}.`, it.materialType.trim(), dims].filter(Boolean).join(" ");
  return `${head}${qtyPart(it.qty)}${refPart(it.itemRef)}`;
}

function generalLine(it: GeneralEmailItem, i: number): string {
  return `${i + 1}. ${it.description.trim()}${qtyPart(it.qty)}${refPart(it.itemRef)}`;
}

function assemble(core: string[]): BuiltEmail["bodyForCopy"] {
  return core.join("\n");
}

export function buildMaterialEmail(subject: string, items: MaterialEmailItem[]): BuiltEmail {
  const core = [
    "Dear Supplier,",
    "",
    RULE,
    "Please quote for the following:",
    "*(00.00) = order size in mm",
    "*0.00 = Finishing size: max allowance +5mm.",
    RULE,
    "",
    ...items.map(materialLine),
    "",
    "Payment Term:",
    "",
    "Please advise the soonest Delivery Date, and Stock availability.",
    "Thank you.",
  ];
  return {
    subject: ensureRfqPrefix(subject),
    bodyForCopy: assemble(core),
    bodyForMail: assemble([...core, "", ...SIGNATURE, "http://helixpoint.com.my"]),
  };
}

export function buildGeneralEmail(subject: string, items: GeneralEmailItem[]): BuiltEmail {
  const core = [
    "Dear Supplier,",
    "",
    RULE,
    "Please quote for the following:",
    RULE,
    "",
    ...items.map(generalLine),
    "",
    "Please advise the soonest Delivery Date, and Stock availability.",
    "Thank you.",
  ];
  return {
    subject: ensureRfqPrefix(subject),
    bodyForCopy: assemble(core),
    bodyForMail: assemble([...core, "", ...SIGNATURE]),
  };
}

/** Gmail compose link. Recipients are deliberately BCC — suppliers competing
 *  on the same enquiry must not see each other. */
export function gmailComposeUrl(bcc: string[], subject: string, body: string): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    bcc: bcc.filter(Boolean).join(","),
    su: subject,
    body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** mailto: fallback — recipients in BCC here too. */
export function mailtoUrl(bcc: string[], subject: string, body: string): string {
  const addr = bcc.filter(Boolean).join(",");
  return `mailto:?bcc=${encodeURIComponent(addr)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

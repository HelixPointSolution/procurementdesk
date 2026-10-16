"use client";

/* Browser-side preparation of a quotation file before upload.
 *
 * Phone photos of a printed quotation are often 4–8 MB and 4000px wide, far
 * larger than needed to read text: they are scaled to at most 2400px on the
 * long side. A LONG screenshot is different (client, 16 Oct 2026: small text
 * in a screenshot of many items could not be read): shrinking it to fit made
 * the text tiny, so it is cut into overlapping pages instead, each read at
 * full sharpness. Screenshots stay PNG when they fit; photos become JPEG.
 * PDFs and pasted text pass through untouched. HEIC (iPhone default) cannot
 * be decoded by most browsers or read by the API, so it is rejected with a
 * clear instruction.
 */

const MAX_EDGE = 2400;
const TARGET_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;

/** Taller than this (height ÷ width) counts as a long screenshot. */
const TALL_RATIO = 1.8;
/** Shape of each page cut from it — roughly A4. */
const PAGE_RATIO = 1.4;
const MAX_PAGES = 8;

export type Prepared = { ok: true; files: File[] } | { ok: false; error: string };

/**
 * Vertical pages for a picture: one for normal shapes, several for a long
 * screenshot. Pages overlap a little so a row cut at a border is whole on one
 * of them; the reader is told that a line seen twice is one line.
 */
export function sliceRanges(width: number, height: number): Array<{ y: number; h: number }> {
  if (width <= 0 || height <= 0 || height / width <= TALL_RATIO) return [{ y: 0, h: height }];
  const overlap = Math.round(width * 0.06);
  const pageH = Math.round(width * PAGE_RATIO);
  const count = Math.min(MAX_PAGES, Math.max(2, Math.ceil((height - overlap) / (pageH - overlap))));
  const h = Math.ceil((height + overlap * (count - 1)) / count);
  return Array.from({ length: count }, (_, i) => {
    const y = Math.min(i * (h - overlap), height - h);
    return { y, h: i === count - 1 ? height - y : h };
  });
}

async function encode(canvas: HTMLCanvasElement, preferPng: boolean): Promise<Blob | null> {
  const toBlob = (type: string, q?: number) =>
    new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  if (preferPng) {
    const png = await toBlob("image/png");
    if (png && png.size <= TARGET_BYTES) return png;
  }
  for (const quality of [0.9, 0.8, 0.65]) {
    const jpg = await toBlob("image/jpeg", quality);
    if (jpg && jpg.size <= TARGET_BYTES) return jpg;
  }
  return null;
}

export async function prepareQuotationFile(file: File): Promise<Prepared> {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    if (file.size > MAX_PDF_BYTES) return { ok: false, error: `${file.name} is over 10 MB.` };
    return { ok: true, files: [file] };
  }
  if (type.startsWith("text/plain")) {
    if (file.size > MAX_TEXT_BYTES) return { ok: false, error: "The pasted text is too long — paste one supplier at a time." };
    return { ok: true, files: [file] };
  }
  if (type.includes("heic") || type.includes("heif") || /\.(heic|heif)$/.test(name)) {
    return {
      ok: false,
      error: `${file.name} is an iPhone HEIC photo. Take it again as JPG (Settings → Camera → Formats → Most Compatible) or send it as a PDF.`,
    };
  }
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) {
    return { ok: false, error: `${file.name}: only PDF, JPG, PNG or WebP can be read.` };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: `${file.name} could not be opened as an image.` };
  }

  const pages = sliceRanges(bitmap.width, bitmap.height);
  const fitsAsIs = pages.length === 1 && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE && file.size <= TARGET_BYTES;
  if (fitsAsIs) {
    bitmap.close();
    return { ok: true, files: [file] };
  }

  // Screenshots (PNG/WebP/GIF) keep crisp text as PNG; camera photos are JPEG anyway.
  const preferPng = type !== "image/jpeg";
  const base = file.name.replace(/\.[^.]+$/, "");
  const out: File[] = [];
  for (let n = 0; n < pages.length; n++) {
    const { y, h } = pages[n];
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); return { ok: false, error: "Could not process the image." }; }
    ctx.fillStyle = "#fff"; // transparent PNGs would otherwise turn black as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, y, bitmap.width, h, 0, 0, canvas.width, canvas.height);

    const blob = await encode(canvas, preferPng);
    if (!blob) { bitmap.close(); return { ok: false, error: `${file.name} is too large even after shrinking — send it as a PDF.` }; }
    const ext = blob.type === "image/png" ? "png" : "jpg";
    const label = pages.length > 1 ? ` (part ${n + 1} of ${pages.length})` : "";
    out.push(new File([blob], `${base}${label}.${ext}`, { type: blob.type }));
  }
  bitmap.close();
  return { ok: true, files: out };
}

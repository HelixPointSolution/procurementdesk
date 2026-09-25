"use client";

/* Browser-side preparation of a quotation file before upload.
 *
 * Phone photos of a printed quotation are often 4–8 MB and 4000px wide, over
 * the API's 5 MB image cap and far larger than needed to read text. They are
 * scaled to at most 2000px on the long side and re-encoded as JPEG. PDFs pass
 * through untouched. HEIC (iPhone default) cannot be decoded by most browsers
 * or read by the API, so it is rejected with a clear instruction.
 */

const MAX_EDGE = 2000;
const TARGET_BYTES = 3 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type Prepared = { ok: true; file: File } | { ok: false; error: string };

export async function prepareQuotationFile(file: File): Promise<Prepared> {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    if (file.size > MAX_PDF_BYTES) return { ok: false, error: `${file.name} is over 10 MB.` };
    return { ok: true, file };
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
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= TARGET_BYTES) {
    bitmap.close();
    return { ok: true, file };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close(); return { ok: false, error: "Could not process the image." }; }
  ctx.fillStyle = "#fff"; // transparent PNGs would otherwise turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (blob && blob.size <= TARGET_BYTES) {
      const base = file.name.replace(/\.[^.]+$/, "");
      return { ok: true, file: new File([blob], `${base}.jpg`, { type: "image/jpeg" }) };
    }
  }
  return { ok: false, error: `${file.name} is too large even after shrinking — send it as a PDF.` };
}

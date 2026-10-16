/* POST /api/extract-quote — read one supplier quotation with Gemini.
 *
 * Body: { rfqId: string, paths: string[] }  objects in the quotation-files
 *       bucket, in page order — one PDF, several pictures of one quotation,
 *       or a pasted message stored as .txt. ({ path } is still accepted.)
 * Auth: the caller's Supabase access token as "Authorization: Bearer …".
 *
 * The file is fetched from Supabase Storage here, server-side, under the
 * caller's own RLS policies — so a 10 MB PDF never has to fit through the
 * platform's request-body limit, and nobody unauthenticated can spend API
 * credit. GEMINI_API_KEY lives only in the server environment.
 *
 * Responses:
 *   200 { extraction }                 structured result (see src/lib/extract.ts)
 *   401 { error }                      not signed in
 *   415 { error }                      file type that cannot be read
 *   422 { error }                      model declined or returned unusable output
 *   429 / 503 { error, retryable }     every model busy or rate-limited — try again shortly
 *   503 { error: "not_configured" }    GEMINI_API_KEY not set — the UI falls
 *                                      back to manual entry with the file attached
 */

import { createClient } from "@supabase/supabase-js";
import { EXTRACTABLE_TYPES, type ExtractionRfqItem } from "@/lib/extract";
import { extractQuotation, ExtractionApiError, isBusyError, type QuotationFile } from "@/lib/quoteExtract";

// A multi-page PDF can take a minute or more to read.
export const maxDuration = 300;

const BUCKET = "quotation-files";
const MAX_BYTES = { pdf: 10 * 1024 * 1024, image: 5 * 1024 * 1024, text: 200 * 1024 } as const;
// Gemini takes at most 20 MB of inline data per request, and base64 adds a third.
const MAX_TOTAL_BYTES = 14 * 1024 * 1024;
const MAX_FILES = 12;

const BUSY_MESSAGE = "Google's AI is busy right now — wait a minute, then press “Read again”.";
const LIMIT_MESSAGE = "The AI's usage limit was reached for now — wait a minute, then press “Read again”.";

function mediaTypeFor(path: string, blobType: string): string {
  const t = blobType.split(";")[0].trim().toLowerCase();
  if (t && EXTRACTABLE_TYPES[t]) return t;
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return ({
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif", txt: "text/plain",
  } as Record<string, string>)[ext] ?? t;
}

export async function POST(request: Request) {
  // --- auth -------------------------------------------------------------
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Not signed in." }, { status: 401 });

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } }
  );
  const { data: userData, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !userData.user) return Response.json({ error: "Not signed in." }, { status: 401 });

  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  // --- input ------------------------------------------------------------
  let body: { rfqId?: string; path?: string; paths?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }
  const { rfqId } = body;
  const paths: unknown[] = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
  if (
    !rfqId || paths.length === 0 || paths.length > MAX_FILES ||
    !paths.every((p): p is string => typeof p === "string" && p.startsWith(`${rfqId}/`))
  ) {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const [{ data: rfq, error: rfqErr }, { data: rows, error: itemsErr }] = await Promise.all([
    sb.from("rfqs").select("kind").eq("id", rfqId).single(),
    sb.from("rfq_items").select("*").eq("rfq_id", rfqId).eq("stage", "review").order("position"),
  ]);
  if (rfqErr || itemsErr || !rfq) {
    return Response.json({ error: "Could not load the RFQ." }, { status: 404 });
  }
  const isMaterial = (rfq as { kind: string }).kind === "material";
  const items: ExtractionRfqItem[] = (rows ?? []).map((r) => ({
    materialType: r.material_type ?? "",
    description: r.description ?? "",
    thicknessRaw: r.thickness_raw ?? "",
    heightRaw: r.height_raw ?? "",
    lengthRaw: r.length_raw ?? "",
    qty: r.qty,
    itemRef: r.item_ref ?? "",
  }));
  if (items.length === 0) {
    return Response.json({ error: "This RFQ has no reviewed items to match against." }, { status: 422 });
  }

  const downloads = await Promise.all(paths.map((p) => sb.storage.from(BUCKET).download(p)));
  const files: QuotationFile[] = [];
  let totalBytes = 0;
  for (let n = 0; n < paths.length; n++) {
    const { data: blob, error: dlErr } = downloads[n];
    if (dlErr || !blob) return Response.json({ error: "Could not read the uploaded file." }, { status: 404 });
    const mediaType = mediaTypeFor(paths[n], blob.type);
    const kind = EXTRACTABLE_TYPES[mediaType];
    if (!kind) {
      return Response.json(
        { error: "Only PDF, JPG, PNG or WebP files can be read automatically." },
        { status: 415 }
      );
    }
    totalBytes += blob.size;
    if (blob.size > MAX_BYTES[kind] || totalBytes > MAX_TOTAL_BYTES) {
      return Response.json({ error: "File is too large to read automatically." }, { status: 413 });
    }
    files.push({ mediaType, data: Buffer.from(await blob.arrayBuffer()).toString("base64") });
  }

  // --- Gemini -----------------------------------------------------------
  try {
    const result = await extractQuotation({ files, items, isMaterial });
    if (result.ok) return Response.json({ extraction: result.extraction });
    const message = {
      refusal: "The quotation could not be read automatically.",
      too_long: "The quotation was too long to read in one go.",
      bad_output: "The reader returned an unexpected result.",
      unsupported_type: "Only PDF, JPG, PNG or WebP files can be read automatically.",
    }[result.failure.kind];
    return Response.json({ error: message }, { status: result.failure.kind === "unsupported_type" ? 415 : 422 });
  } catch (err) {
    // Status and message only — never the file or the prices.
    console.error(
      "extract-quote failed:",
      err instanceof ExtractionApiError ? err.status : "",
      err instanceof Error ? err.message : String(err)
    );
    if (err instanceof ExtractionApiError) {
      if (err.status === 401 || err.status === 403) {
        return Response.json({ error: "The AI key is invalid or not allowed — check GEMINI_API_KEY." }, { status: 503 });
      }
      if (err.status === 429) return Response.json({ error: LIMIT_MESSAGE, retryable: true }, { status: 429 });
      if (err.status === 400) {
        return Response.json({ error: `The file could not be processed: ${err.message}` }, { status: 422 });
      }
      if (isBusyError(err)) return Response.json({ error: BUSY_MESSAGE, retryable: true }, { status: 503 });
      return Response.json({ error: `AI service error (${err.status}). Press “Read again”.` }, { status: 502 });
    }
    if (isBusyError(err)) return Response.json({ error: BUSY_MESSAGE, retryable: true }, { status: 503 });
    return Response.json({ error: "Unexpected error while reading the quotation." }, { status: 500 });
  }
}

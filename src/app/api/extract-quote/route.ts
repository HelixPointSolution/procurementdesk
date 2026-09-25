/* POST /api/extract-quote — read one supplier quotation with Claude.
 *
 * Body: { rfqId: string, path: string }  (path = object in the quotation-files bucket)
 * Auth: the caller's Supabase access token as "Authorization: Bearer …".
 *
 * The file is fetched from Supabase Storage here, server-side, under the
 * caller's own RLS policies — so a 10 MB PDF never has to fit through the
 * platform's request-body limit, and nobody unauthenticated can spend API
 * credit. ANTHROPIC_API_KEY lives only in the server environment.
 *
 * Responses:
 *   200 { extraction }                 structured result (see src/lib/extract.ts)
 *   401 { error }                      not signed in
 *   415 { error }                      file type Claude cannot read
 *   422 { error }                      model declined or returned unusable output
 *   503 { error: "not_configured" }    ANTHROPIC_API_KEY not set — the UI falls
 *                                      back to manual entry with the file attached
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  buildExtractionPrompt, EXTRACTABLE_TYPES, EXTRACTION_SCHEMA,
  type Extraction, type ExtractionRfqItem,
} from "@/lib/extract";

// A multi-page PDF with adaptive thinking can take a minute or more.
export const maxDuration = 300;

const BUCKET = "quotation-files";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // base64 must stay under the API's 5 MB image cap

function mediaTypeFor(path: string, blobType: string): string {
  if (blobType && EXTRACTABLE_TYPES[blobType]) return blobType;
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[ext] ?? blobType;
}

function isExtraction(x: unknown): x is Extraction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.supplier_name === "string" && typeof o.currency === "string" &&
    typeof o.notes === "string" && Array.isArray(o.lines);
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  // --- input ------------------------------------------------------------
  let body: { rfqId?: string; path?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }
  const { rfqId, path } = body;
  if (!rfqId || !path || !path.startsWith(`${rfqId}/`)) {
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

  const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(path);
  if (dlErr || !blob) return Response.json({ error: "Could not read the uploaded file." }, { status: 404 });

  const mediaType = mediaTypeFor(path, blob.type);
  const kind = EXTRACTABLE_TYPES[mediaType];
  if (!kind) {
    return Response.json(
      { error: "Only PDF, JPG, PNG or WebP files can be read automatically." },
      { status: 415 }
    );
  }
  if (blob.size > (kind === "pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
    return Response.json({ error: "File is too large to read automatically." }, { status: 413 });
  }
  const data = Buffer.from(await blob.arrayBuffer()).toString("base64");

  // --- Claude -----------------------------------------------------------
  const fileBlock: Anthropic.Beta.BetaContentBlockParam = kind === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : {
        type: "image",
        source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data },
      };

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      // A declined request is re-run server-side on Anthropic's recommended
      // fallback model instead of failing the upload.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
      messages: [{
        role: "user",
        content: [fileBlock, { type: "text", text: buildExtractionPrompt(items, isMaterial) }],
      }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "The quotation could not be read automatically." }, { status: 422 });
    }
    if (response.stop_reason === "max_tokens") {
      return Response.json({ error: "The quotation was too long to read in one go." }, { status: 422 });
    }

    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!isExtraction(parsed)) {
      return Response.json({ error: "The reader returned an unexpected result." }, { status: 422 });
    }
    return Response.json({ extraction: parsed });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "The AI key is invalid — check ANTHROPIC_API_KEY." }, { status: 503 });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return Response.json({ error: "Too many quotations at once — try again in a minute." }, { status: 429 });
    }
    if (err instanceof Anthropic.BadRequestError) {
      return Response.json({ error: `The file could not be processed: ${err.message}` }, { status: 422 });
    }
    if (err instanceof Anthropic.APIError) {
      return Response.json({ error: `AI service error (${err.status ?? "?"}). Try again.` }, { status: 502 });
    }
    return Response.json({ error: "Unexpected error while reading the quotation." }, { status: 500 });
  }
}

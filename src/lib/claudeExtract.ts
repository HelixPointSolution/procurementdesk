/* Server-side half of quotation reading: one Claude call per quotation.
 *
 * Used by the /api/extract-quote route and by the live evaluation test
 * (src/lib/__tests__/extract.live.test.ts). Never import this from a client
 * component — it needs ANTHROPIC_API_KEY, which must stay on the server.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildExtractionPrompt, EXTRACTABLE_TYPES, EXTRACTION_SCHEMA,
  type Extraction, type ExtractionRfqItem,
} from "./extract";

export type ExtractFailure =
  | { kind: "refusal" }
  | { kind: "too_long" }
  | { kind: "bad_output" }
  | { kind: "unsupported_type" };

export type ExtractResult = { ok: true; extraction: Extraction } | { ok: false; failure: ExtractFailure };

function isExtraction(x: unknown): x is Extraction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.supplier_name === "string" && typeof o.currency === "string" &&
    typeof o.notes === "string" && Array.isArray(o.lines);
}

/**
 * Read one quotation. `data` is the file as base64. Typed SDK errors
 * (authentication, rate limit, bad request…) propagate to the caller.
 */
export async function extractQuotation(args: {
  data: string;
  mediaType: string;
  items: ExtractionRfqItem[];
  isMaterial: boolean;
  client?: Anthropic;
}): Promise<ExtractResult> {
  const kind = EXTRACTABLE_TYPES[args.mediaType];
  if (!kind) return { ok: false, failure: { kind: "unsupported_type" } };

  const fileBlock: Anthropic.Beta.BetaContentBlockParam = kind === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: args.data } }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type: args.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
          data: args.data,
        },
      };

  const client = args.client ?? new Anthropic();
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
      content: [fileBlock, { type: "text", text: buildExtractionPrompt(args.items, args.isMaterial) }],
    }],
  });

  if (response.stop_reason === "refusal") return { ok: false, failure: { kind: "refusal" } };
  if (response.stop_reason === "max_tokens") return { ok: false, failure: { kind: "too_long" } };

  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!isExtraction(parsed)) return { ok: false, failure: { kind: "bad_output" } };
  return { ok: true, extraction: parsed };
}

/* Server-side half of quotation reading: one Gemini call per quotation.
 *
 * Used by the /api/extract-quote route and by the live evaluation test
 * (src/lib/__tests__/extract.live.test.ts). Never import this from a client
 * component — it needs GEMINI_API_KEY, which must stay on the server.
 *
 * Model: gemini-3.8-flash (chosen by the owner, 9 Oct 2026), confirmed
 * available to the project's key via the models list endpoint.
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import {
  buildExtractionPrompt, EXTRACTABLE_TYPES, EXTRACTION_SCHEMA,
  type Extraction, type ExtractionRfqItem,
} from "./extract";

export const EXTRACTION_MODEL = "gemini-3.8-flash";

export type ExtractFailure =
  | { kind: "refusal" }
  | { kind: "too_long" }
  | { kind: "bad_output" }
  | { kind: "unsupported_type" };

export type ExtractResult = { ok: true; extraction: Extraction } | { ok: false; failure: ExtractFailure };

/** Finish reasons meaning the model declined to answer. */
const BLOCKED = new Set<string>([
  FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT, FinishReason.SPII,
]);

function isExtraction(x: unknown): x is Extraction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.supplier_name === "string" && typeof o.currency === "string" &&
    typeof o.notes === "string" && Array.isArray(o.lines);
}

/** Re-exported so callers can tell a bad key / rate limit from other failures. */
export { ApiError as ExtractionApiError };

/**
 * Read one quotation. `data` is the file as base64. API errors
 * (invalid key, rate limit, bad request…) propagate as ApiError with `.status`.
 */
export async function extractQuotation(args: {
  data: string;
  mediaType: string;
  items: ExtractionRfqItem[];
  isMaterial: boolean;
  client?: GoogleGenAI;
}): Promise<ExtractResult> {
  if (!EXTRACTABLE_TYPES[args.mediaType]) return { ok: false, failure: { kind: "unsupported_type" } };

  // Retries are off by default. On 9 Oct 2026 the very first live run got
  // 503 "model is currently experiencing high demand" — transient, so back
  // off and try again rather than failing the purchaser's upload.
  const ai = args.client ?? new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      retryOptions: {
        attempts: 5,
        initialDelay: 2,
        maxDelay: 20,
        httpStatusCodes: [429, 500, 502, 503, 504],
      },
    },
  });
  const response = await ai.models.generateContent({
    model: EXTRACTION_MODEL,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: args.mediaType, data: args.data } },
        { text: buildExtractionPrompt(args.items, args.isMaterial) },
      ],
    }],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: EXTRACTION_SCHEMA,
      maxOutputTokens: 16000,
    },
  });

  if (response.promptFeedback?.blockReason) return { ok: false, failure: { kind: "refusal" } };
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && BLOCKED.has(finish)) return { ok: false, failure: { kind: "refusal" } };
  if (finish === FinishReason.MAX_TOKENS) return { ok: false, failure: { kind: "too_long" } };

  let parsed: unknown;
  try { parsed = JSON.parse(response.text ?? ""); } catch { parsed = null; }
  if (!isExtraction(parsed)) return { ok: false, failure: { kind: "bad_output" } };
  return { ok: true, extraction: parsed };
}

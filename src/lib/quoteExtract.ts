/* Server-side half of quotation reading: one Gemini call per quotation.
 *
 * Used by the /api/extract-quote route and by the live evaluation test
 * (src/lib/__tests__/extract.live.test.ts). Never import this from a client
 * component — it needs GEMINI_API_KEY, which must stay on the server.
 *
 * Models: gemini-3.8-flash (chosen by the owner, 9 Oct 2026), then backups.
 * On 16 Oct 2026 the client's first real uploads failed with 503 "high
 * demand" and 429 rate limits. Each model has its own capacity and quota, so
 * a busy model hands over to the next instead of failing the upload. All
 * three were confirmed on the project key's models list.
 */

import { ApiError, FinishReason, GoogleGenAI, MediaResolution, type Part } from "@google/genai";
import {
  buildExtractionPrompt, EXTRACTABLE_TYPES, EXTRACTION_SCHEMA,
  type Extraction, type ExtractionRfqItem,
} from "./extract";

export const EXTRACTION_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"] as const;

export type ExtractFailure =
  | { kind: "refusal" }
  | { kind: "too_long" }
  | { kind: "bad_output" }
  | { kind: "unsupported_type" };

export type ExtractResult =
  | { ok: true; extraction: Extraction; model: string }
  | { ok: false; failure: ExtractFailure };

/** One part of a quotation: a PDF, a picture, or pasted text — all base64. */
export interface QuotationFile {
  mediaType: string;
  data: string;
}

/** Finish reasons meaning the model declined to answer. */
const BLOCKED = new Set<string>([
  FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT, FinishReason.SPII,
]);

/** Overloaded, rate-limited or briefly down: another model may well answer. */
const BUSY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Leave the route (maxDuration 300 s) time to answer before the platform cuts it off. */
const BUDGET_MS = 230_000;

function isExtraction(x: unknown): x is Extraction {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.supplier_name === "string" && typeof o.currency === "string" &&
    typeof o.notes === "string" && Array.isArray(o.lines);
}

/** Re-exported so callers can tell a bad key / rate limit from other failures. */
export { ApiError as ExtractionApiError };

/** True for failures worth handing to the next model: overload, rate limit,
 *  timeout, dropped connection. A bad key or a bad file is not one of them. */
export function isBusyError(err: unknown): boolean {
  if (err instanceof ApiError) return BUSY_STATUS.has(err.status);
  if (!(err instanceof Error)) return false;
  return /abort|time ?out|timed out|fetch failed|network|ECONNRESET|socket hang up/i.test(`${err.name} ${err.message}`);
}

function toPart(f: QuotationFile): Part {
  if (EXTRACTABLE_TYPES[f.mediaType] === "text") {
    return { text: `--- Quotation text, pasted from a message ---\n${Buffer.from(f.data, "base64").toString("utf8")}` };
  }
  return { inlineData: { mimeType: f.mediaType, data: f.data } };
}

/**
 * Read one supplier's quotation, given as one or more parts in page order.
 * API errors (invalid key, rate limit, bad request…) propagate as ApiError
 * with `.status` once every model has been tried.
 */
export async function extractQuotation(args: {
  files: QuotationFile[];
  items: ExtractionRfqItem[];
  isMaterial: boolean;
  client?: GoogleGenAI;
  models?: readonly string[];
}): Promise<ExtractResult> {
  if (args.files.length === 0 || args.files.some((f) => !EXTRACTABLE_TYPES[f.mediaType])) {
    return { ok: false, failure: { kind: "unsupported_type" } };
  }

  // 5xx is retried on the same model, briefly. 429 is not: that model's quota
  // is spent for now, so move straight to the next one.
  const ai = args.client ?? new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      timeout: 100_000,
      retryOptions: { attempts: 3, initialDelay: 2, maxDelay: 8, httpStatusCodes: [500, 502, 503, 504] },
    },
  });

  const hasText = args.files.some((f) => EXTRACTABLE_TYPES[f.mediaType] === "text");
  // Screenshots carry small print: read pictures at high resolution. Set for
  // the whole request (long supported by every model) and only when there is
  // a picture, so PDF requests stay exactly as verified live on 9 Oct.
  const hasImage = args.files.some((f) => EXTRACTABLE_TYPES[f.mediaType] === "image");
  const parts: Part[] = [
    ...args.files.map(toPart),
    { text: buildExtractionPrompt(args.items, args.isMaterial, { parts: args.files.length, hasText }) },
  ];

  const started = Date.now();
  let lastError: unknown = null;
  let lastFailure: ExtractFailure | null = null;
  for (const model of args.models ?? EXTRACTION_MODELS) {
    if ((lastError || lastFailure) && Date.now() - started > BUDGET_MS) break;
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: EXTRACTION_SCHEMA,
          maxOutputTokens: 16000,
          ...(hasImage ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH } : {}),
        },
      });
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastError = err;
      continue;
    }

    if (response.promptFeedback?.blockReason) return { ok: false, failure: { kind: "refusal" } };
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && BLOCKED.has(finish)) return { ok: false, failure: { kind: "refusal" } };
    if (finish === FinishReason.MAX_TOKENS) return { ok: false, failure: { kind: "too_long" } };

    let parsed: unknown;
    try { parsed = JSON.parse(response.text ?? ""); } catch { parsed = null; }
    if (isExtraction(parsed)) return { ok: true, extraction: parsed, model };
    // Malformed output is usually a one-off; the next model gets a go.
    lastFailure = { kind: "bad_output" };
  }

  if (lastFailure) return { ok: false, failure: lastFailure };
  throw lastError;
}

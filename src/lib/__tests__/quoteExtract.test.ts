import { describe, it, expect } from "vitest";
import { ApiError, type GoogleGenAI } from "@google/genai";
import { extractQuotation, isBusyError, EXTRACTION_MODELS } from "../quoteExtract";
import { buildExtractionPrompt, type ExtractionRfqItem } from "../extract";

const ITEMS: ExtractionRfqItem[] = [
  { materialType: "P20", description: "", thicknessRaw: "15.00", heightRaw: "60.00", lengthRaw: "90.00", qty: 2, itemRef: "" },
];
const GOOD = { supplier_name: "SUPPLIER A", currency: "RM", notes: "", lines: [] };
const ok = (body: unknown = GOOD) => ({ text: JSON.stringify(body), candidates: [{ finishReason: "STOP" }] });
const busy = (status: number) => new ApiError({ message: `status ${status}`, status });

/** A stand-in for the SDK client: answers per model from a script. */
function fakeClient(script: Record<string, () => unknown>) {
  const calls: Array<{ model: string; parts: Array<Record<string, unknown>>; config: Record<string, unknown> }> = [];
  const client = {
    models: {
      generateContent: async (req: {
        model: string; contents: Array<{ parts: Array<Record<string, unknown>> }>; config: Record<string, unknown>;
      }) => {
        calls.push({ model: req.model, parts: req.contents[0].parts, config: req.config });
        const step = script[req.model];
        if (!step) throw new Error("unexpected model " + req.model);
        return step();
      },
    },
  } as unknown as GoogleGenAI;
  return { client, calls };
}

const PDF = [{ mediaType: "application/pdf", data: "JVBERi0=" }];

describe("extractQuotation — falls back when Google is busy (client, 16 Oct)", () => {
  it("hands a 503 'high demand' to the next model", async () => {
    const { client, calls } = fakeClient({
      [EXTRACTION_MODELS[0]]: () => { throw busy(503); },
      [EXTRACTION_MODELS[1]]: () => ok(),
    });
    const r = await extractQuotation({ files: PDF, items: ITEMS, isMaterial: true, client });
    expect(r).toMatchObject({ ok: true, model: EXTRACTION_MODELS[1] });
    expect(calls.map((c) => c.model)).toEqual([EXTRACTION_MODELS[0], EXTRACTION_MODELS[1]]);
  });

  it("hands a 429 rate limit to the next model too", async () => {
    const { client } = fakeClient({
      [EXTRACTION_MODELS[0]]: () => { throw busy(429); },
      [EXTRACTION_MODELS[1]]: () => { throw busy(429); },
      [EXTRACTION_MODELS[2]]: () => ok(),
    });
    const r = await extractQuotation({ files: PDF, items: ITEMS, isMaterial: true, client });
    expect(r).toMatchObject({ ok: true, model: EXTRACTION_MODELS[2] });
  });

  it("throws the last error when every model is busy", async () => {
    const { client } = fakeClient(Object.fromEntries(EXTRACTION_MODELS.map((m) => [m, () => { throw busy(503); }])));
    await expect(extractQuotation({ files: PDF, items: ITEMS, isMaterial: true, client })).rejects.toMatchObject({ status: 503 });
  });

  it("does not retry other models for a bad key or a bad file", async () => {
    const { client, calls } = fakeClient({ [EXTRACTION_MODELS[0]]: () => { throw busy(400); } });
    await expect(extractQuotation({ files: PDF, items: ITEMS, isMaterial: true, client })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("tries the next model after malformed output", async () => {
    const { client } = fakeClient({
      [EXTRACTION_MODELS[0]]: () => ({ text: "not json", candidates: [{ finishReason: "STOP" }] }),
      [EXTRACTION_MODELS[1]]: () => ok(),
    });
    expect(await extractQuotation({ files: PDF, items: ITEMS, isMaterial: true, client })).toMatchObject({ ok: true });
  });
});

describe("extractQuotation — parts", () => {
  it("sends pasted text as text, and pictures at high resolution, before the prompt", async () => {
    const { client, calls } = fakeClient({ [EXTRACTION_MODELS[0]]: () => ok() });
    await extractQuotation({
      files: [
        { mediaType: "text/plain", data: Buffer.from("P20 15.0 x 60.0 x 90.0 RM 30.00 2pcs").toString("base64") },
        { mediaType: "image/png", data: "iVBORw0K" },
      ],
      items: ITEMS, isMaterial: true, client,
    });
    const [text, image, prompt] = calls[0].parts;
    expect(text.text).toContain("RM 30.00");
    expect(image.inlineData).toEqual({ mimeType: "image/png", data: "iVBORw0K" });
    expect(calls[0].config.mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
    expect(String(prompt.text)).toContain("ONE supplier's quotation");
  });

  it("leaves a PDF-only request exactly as before (no resolution override)", async () => {
    const { client, calls } = fakeClient({ [EXTRACTION_MODELS[0]]: () => ok() });
    await extractQuotation({ files: PDF, items: ITEMS, isMaterial: true, client });
    expect(calls[0].config).not.toHaveProperty("mediaResolution");
    expect(calls[0].parts[0]).toEqual({ inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } });
  });

  it("refuses an unknown file type without calling the model", async () => {
    const { client, calls } = fakeClient({});
    const r = await extractQuotation({ files: [{ mediaType: "image/heic", data: "" }], items: ITEMS, isMaterial: true, client });
    expect(r).toEqual({ ok: false, failure: { kind: "unsupported_type" } });
    expect(calls).toHaveLength(0);
  });
});

describe("isBusyError", () => {
  it("covers overload, rate limit and timeouts, not bad requests", () => {
    expect(isBusyError(busy(503))).toBe(true);
    expect(isBusyError(busy(429))).toBe(true);
    expect(isBusyError(busy(400))).toBe(false);
    expect(isBusyError(busy(403))).toBe(false);
    expect(isBusyError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe(true);
    expect(isBusyError(new TypeError("fetch failed"))).toBe(true);
    expect(isBusyError(new Error("something else"))).toBe(false);
  });
});

describe("buildExtractionPrompt — sources", () => {
  it("says a single file by default", () => {
    expect(buildExtractionPrompt(ITEMS, true)).toContain("The attached file is a supplier's quotation");
  });
  it("says pages of one quotation, overlapping, for several parts", () => {
    const p = buildExtractionPrompt(ITEMS, true, { parts: 3, hasText: false });
    expect(p).toContain("The 3 parts above");
    expect(p).toMatch(/overlap/);
  });
  it("says copied from a message for pasted text", () => {
    expect(buildExtractionPrompt(ITEMS, true, { parts: 1, hasText: true })).toContain("copied from a message");
  });
  it("asks for dimensions in our order without changing values", () => {
    expect(buildExtractionPrompt(ITEMS, true)).toMatch(/thickness, height, length/);
  });
});

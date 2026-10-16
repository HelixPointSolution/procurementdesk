/* Live check of quotation reading against real supplier quotations.
 *
 * Skipped unless BOTH are set:
 *   GEMINI_API_KEY       — makes real (billed) API calls
 *   QUOTE_FIXTURES_DIR   — folder holding the quotations and cases.json
 * Optional:
 *   LIVE_MODELS          — comma-separated model ids to force, e.g. to check a
 *                          fallback model on its own ("gemini-3.5-flash")
 *
 * The fixtures are client documents with real prices, so they live OUTSIDE
 * this repository (which is public). cases.json holds one or more RFQ sets:
 * the RFQ items, and per quotation the per-piece price and quantity a
 * purchaser would read off it, plus the expected total. A case may list
 * several files (pages of one quotation, e.g. a long screenshot cut up).
 *
 *   GEMINI_API_KEY=... QUOTE_FIXTURES_DIR=../_private/quote-fixtures \
 *     npx vitest run src/lib/__tests__/extract.live.test.ts
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractQuotation } from "../quoteExtract";
import { mapExtraction, type ExtractionRfqItem } from "../extract";
import { analyseQuotes } from "../compare";
import { parsePrice, parseQty } from "../num";

interface Case {
  file?: string;
  files?: string[];
  why: string;
  supplierContains: string;
  lines: Array<{ item: number; unitPrice: number; qty: number }>;
  total: number;
}
interface FixtureSet {
  name?: string;
  rfq: { isMaterial: boolean; items: ExtractionRfqItem[] };
  cases: Case[];
  expectRecommended: string;
}

const MEDIA: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain",
};

const dir = process.env.QUOTE_FIXTURES_DIR;
const enabled = !!process.env.GEMINI_API_KEY && !!dir && fs.existsSync(path.join(dir ?? "", "cases.json"));
const raw = enabled ? JSON.parse(fs.readFileSync(path.join(dir as string, "cases.json"), "utf8")) : null;
const sets: FixtureSet[] = raw ? (Array.isArray(raw.sets) ? raw.sets : [raw]) : [];
// { "rfq": { "$ref": "previous" } } reuses the set before's RFQ (same quotes, other formats).
sets.forEach((s, i) => { if ("$ref" in s.rfq && i > 0) s.rfq = sets[i - 1].rfq; });
const models = process.env.LIVE_MODELS?.split(",").map((m) => m.trim()).filter(Boolean);

if (sets.length === 0) {
  describe.skip("live quotation reading (needs GEMINI_API_KEY + QUOTE_FIXTURES_DIR)", () => {
    it("reads real quotations", () => {});
  });
}

for (const set of sets) {
  describe.skipIf(!enabled)(`live quotation reading — ${set.name ?? "real supplier quotations"}`, () => {
    const mapped: Record<string, ReturnType<typeof mapExtraction>> = {};

    for (const c of set.cases) {
      const names = c.files ?? [c.file as string];
      it(`${names.join(" + ")} — ${c.why}`, { timeout: 280_000 }, async () => {
        const files = names.map((n) => ({
          mediaType: MEDIA[n.toLowerCase().split(".").pop() ?? ""],
          data: fs.readFileSync(path.join(dir as string, n)).toString("base64"),
        }));
        const res = await extractQuotation({ files, items: set.rfq.items, isMaterial: set.rfq.isMaterial, models });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        if (!res.ok) return;

        const m = mapExtraction(res.extraction, set.rfq.items, names[0]);
        mapped[names[0]] = m;
        console.log(`\n${names.join(" + ")} — read by ${res.model}\n${JSON.stringify(res.extraction, null, 2)}`);

        expect(m.supplierName.toUpperCase()).toContain(c.supplierContains);
        for (const want of c.lines) {
          const got = m.lines[want.item - 1];
          expect(got.quoted, `item ${want.item} should be priced`).toBe(true);
          expect(parsePrice(got.price), `item ${want.item} price`).toBeCloseTo(want.unitPrice, 2);
          expect(parseQty(got.qty), `item ${want.item} qty`).toBe(want.qty);
        }
      });
    }

    it("ranks the suppliers the way a purchaser would", () => {
      const items = set.rfq.items.map((it, k) => ({ id: `i${k}`, ...it }));
      const r = analyseQuotes(items, Object.values(mapped).map((m) => ({
        supplierName: m.supplierName,
        notes: m.notes,
        items: m.lines
          .map((l, k) => ({ l, id: `i${k}` }))
          .filter(({ l }) => l.quoted)
          .map(({ l, id }) => ({
            rfqItemId: id, thicknessRaw: l.thicknessRaw, heightRaw: l.heightRaw, lengthRaw: l.lengthRaw,
            qty: parseQty(l.qty), price: parsePrice(l.price), notes: l.notes,
          })),
      })));
      for (const c of set.cases) {
        const s = r.suppliers.find((x) => x.supplierName.toUpperCase().includes(c.supplierContains));
        expect(s?.total).toBeCloseTo(c.total, 2);
      }
      expect(r.recommended?.supplierName.toUpperCase()).toContain(set.expectRecommended);
    });
  });
}

/* Live check of quotation reading against real supplier quotations.
 *
 * Skipped unless BOTH are set:
 *   ANTHROPIC_API_KEY    — makes real (billed, a few cents per file) API calls
 *   QUOTE_FIXTURES_DIR   — folder holding the PDFs and cases.json
 *
 * The fixtures are client documents with real prices, so they live OUTSIDE
 * this repository (which is public). cases.json lists, per file, the per-piece
 * price and quantity a purchaser would read off it, plus the expected total.
 *
 *   ANTHROPIC_API_KEY=... QUOTE_FIXTURES_DIR=../_private/quote-fixtures \
 *     npx vitest run src/lib/__tests__/extract.live.test.ts
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractQuotation } from "../claudeExtract";
import { mapExtraction, type ExtractionRfqItem } from "../extract";
import { analyseQuotes } from "../compare";
import { parsePrice, parseQty } from "../num";

interface Case {
  file: string;
  why: string;
  supplierContains: string;
  lines: Array<{ item: number; unitPrice: number; qty: number }>;
  total: number;
}
interface Fixtures {
  rfq: { isMaterial: boolean; items: ExtractionRfqItem[] };
  cases: Case[];
  expectRecommended: string;
}

const dir = process.env.QUOTE_FIXTURES_DIR;
const enabled = !!process.env.ANTHROPIC_API_KEY && !!dir && fs.existsSync(path.join(dir ?? "", "cases.json"));
const fixtures: Fixtures | null = enabled
  ? JSON.parse(fs.readFileSync(path.join(dir as string, "cases.json"), "utf8"))
  : null;

describe.skipIf(!enabled)("live quotation reading (real supplier PDFs)", () => {
  const mapped: Record<string, ReturnType<typeof mapExtraction>> = {};

  for (const c of fixtures?.cases ?? []) {
    it(`${c.file} — ${c.why}`, { timeout: 240_000 }, async () => {
      const f = fixtures as Fixtures;
      const data = fs.readFileSync(path.join(dir as string, c.file)).toString("base64");
      const res = await extractQuotation({
        data, mediaType: "application/pdf", items: f.rfq.items, isMaterial: f.rfq.isMaterial,
      });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;

      const m = mapExtraction(res.extraction, f.rfq.items, c.file);
      mapped[c.file] = m;
      console.log(`\n${c.file}\n${JSON.stringify(res.extraction, null, 2)}`);

      expect(m.supplierName.toUpperCase()).toContain(c.supplierContains);
      for (const want of c.lines) {
        const got = m.lines[want.item - 1];
        expect(got.quoted, `item ${want.item} should be priced`).toBe(true);
        expect(parsePrice(got.price)).toBeCloseTo(want.unitPrice, 2);
        expect(parseQty(got.qty)).toBe(want.qty);
      }
    });
  }

  it("ranks the suppliers the way a purchaser would", () => {
    const f = fixtures as Fixtures;
    const items = f.rfq.items.map((it, k) => ({ id: `i${k}`, ...it }));
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
    for (const c of f.cases) {
      const s = r.suppliers.find((x) => x.supplierName.toUpperCase().includes(c.supplierContains));
      expect(s?.total).toBeCloseTo(c.total, 2);
    }
    expect(r.recommended?.supplierName.toUpperCase()).toContain(f.expectRecommended);
  });
});

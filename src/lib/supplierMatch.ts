/* Suggested-supplier lookup: match an RFQ item's material against the
 * Supplier List's material-keyword groups and return the top suppliers
 * (Excel: "Suggest email1/2/3", ordered by the list's own row order).
 *
 * The client's data is not spelled consistently (RFQ says "SS 304"/"SS304",
 * the list says "SUS 304"; RFQ says "5051", the list has ALU 5052), so
 * matching is normalised + alias-mapped, never exact-string.
 */

export interface MaterialGroup {
  category: string;
  /** Comma-separated keywords, e.g. "SUS 303, SUS 304, SUS 316, 316L" */
  materials: string;
  /** Suppliers in priority order (the Excel row order via sort_order). */
  suppliers: Array<{ name: string; email: string | null }>;
}

export interface Suggestion {
  name: string;
  email: string | null;
  category: string;
  matchedKeyword: string;
}

/** Uppercase, strip spaces/dots/dashes so "SS 304" ≡ "ss304". */
function norm(s: string): string {
  return s.toUpperCase().replace(/[\s.\-_]/g, "");
}

/** Query rewrites applied before matching (client-confirmed assumptions). */
const ALIASES: Array<[RegExp, string]> = [
  [/^SS\s*(?=\d)/i, "SUS "],        // SS 304 → SUS 304 (list uses SUS)
  [/^5051$/i, "ALU 5052"],          // 5051 isn't a real alu grade; nearest family
  [/^(50\d\d|60\d\d|70\d\d)$/i, "ALU $1"], // bare alu series number → ALU prefix
  [/^ALUMINIUM\b/i, "ALU"],
];

function expandQuery(materialType: string): string[] {
  const q = materialType.trim();
  const out = [q];
  for (const [re, sub] of ALIASES) {
    if (re.test(q)) out.push(q.replace(re, sub));
  }
  return out;
}

/**
 * Score a keyword against a query: 2 = exact (normalised), 1 = containment
 * (either direction, min 3 chars to avoid noise), 0 = no match.
 */
function scoreKeyword(keyword: string, query: string): number {
  const k = norm(keyword);
  const q = norm(query);
  if (k === "" || q === "") return 0;
  if (k === q) return 2;
  if (q.length >= 3 && k.length >= 3 && (k.includes(q) || q.includes(k))) return 1;
  return 0;
}

/**
 * Suggest suppliers for a material. Returns deduped suppliers from the
 * best-matching group(s), in group priority order, best matches first.
 * `limit` defaults to 3 per the Excel's Suggest email1/2/3 columns.
 */
export function suggestSuppliers(
  materialType: string | null | undefined,
  groups: MaterialGroup[],
  limit = 3
): Suggestion[] {
  const queries = expandQuery(materialType ?? "");
  if (queries[0] === "") return [];

  // Best score per group across all its keywords and all query variants
  const scored = groups
    .map((g) => {
      let best = 0;
      let matched = "";
      for (const kw of g.materials.split(",").map((s) => s.trim()).filter(Boolean)) {
        for (const q of queries) {
          const s = scoreKeyword(kw, q);
          if (s > best) {
            best = s;
            matched = kw;
          }
        }
      }
      return { group: g, score: best, matched };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const { group, matched } of scored) {
    for (const s of group.suppliers) {
      const key = norm(s.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: s.name, email: s.email, category: group.category, matchedKeyword: matched });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

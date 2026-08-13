/* Shared numeric parsing for user-typed money and quantities.
 *
 * Purchasers paste prices straight off supplier quotations, which routinely
 * carry thousands separators ("1,250.00") and currency prefixes ("RM 25.00").
 * A parser that rejects those silently drops the price: the row still counts
 * as quoted in the UI but stores null, and the comparison engine then treats
 * the item as un-quoted, removing it from the total with no warning.
 *
 * `dimensions.ts` already strips commas when parsing sizes; this keeps the
 * money/qty path consistent with it.
 */

/**
 * Parse a user-entered number. Returns null for blank or unparseable input.
 * Accepts thousands separators, a leading currency symbol/code, and
 * surrounding whitespace. Rejects NaN and non-finite values.
 */
export function parseNumber(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;

  let s = String(input).trim();
  if (s === "") return null;

  // Strip a leading currency marker: "RM 25.00", "MYR25", "$25"
  s = s.replace(/^(rm|myr|sgd|usd|s\$|us\$|[$€£])\s*/i, "");
  // Thousands separators
  s = s.replace(/,/g, "");
  s = s.trim();
  if (s === "") return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a quantity: must be a positive finite number, else null. */
export function parseQty(input: string | number | null | undefined): number | null {
  const n = parseNumber(input);
  return n != null && n > 0 ? n : null;
}

/** Parse a price: must be a non-negative finite number, else null. */
export function parsePrice(input: string | number | null | undefined): number | null {
  const n = parseNumber(input);
  return n != null && n >= 0 ? n : null;
}

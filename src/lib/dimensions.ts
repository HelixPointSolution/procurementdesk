/* Dimension notation (from the client's Excel spec, "RFQ Material" notes):
 *   - "(9.50)"  bracket   = order size in mm
 *   - "9.50"    bare      = finishing size (max allowance +5mm)
 *   - "Ø4.00"   diameter  = round bar; weight uses the round-bar formula
 *
 * Calculation is IDENTICAL with or without brackets (note1), and the same for
 * diameters (note2) — but the brackets and the Ø symbol must be preserved
 * verbatim in the generated RFQ email. So dimensions are stored as the raw
 * string the purchaser typed, and parsed only for math.
 */

export interface ParsedDim {
  value: number;
  isBracket: boolean;
  isDiameter: boolean;
  /** The string exactly as entered (trimmed) — what goes into the email. */
  raw: string;
}

const DIAMETER_CHARS = /[Øø⌀]/;

/** Parse a raw dimension string. Returns null for blank/unparseable input. */
export function parseDim(input: string | null | undefined): ParsedDim | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (raw === "") return null;

  let s = raw;
  const isDiameter = DIAMETER_CHARS.test(s);
  s = s.replace(new RegExp(DIAMETER_CHARS, "g"), "");

  let isBracket = false;
  const m = s.match(/^\s*\(\s*([^()]*)\s*\)\s*$/);
  if (m) {
    isBracket = true;
    s = m[1];
  }

  const value = Number(s.trim().replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;

  return { value, isBracket, isDiameter, raw };
}

/** Numeric value of a raw dimension, or null. */
export function dimValue(input: string | null | undefined): number | null {
  return parseDim(input)?.value ?? null;
}

/** True if any of the given raw dims marks a round bar (Ø). */
export function isRoundItem(...raws: Array<string | null | undefined>): boolean {
  return raws.some((r) => r != null && DIAMETER_CHARS.test(String(r)));
}

/**
 * Compare an inquiry dim with a quoted dim. Brackets/Ø don't affect equality —
 * only the numeric value does (spec: "Calculation is same with or without
 * bracket"). Both missing counts as a match; one missing does not.
 */
export function dimsMatch(
  inquiry: string | null | undefined,
  quoted: string | null | undefined,
  tolerance = 0.001
): boolean {
  const a = parseDim(inquiry);
  const b = parseDim(quoted);
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a.value - b.value) < tolerance;
}

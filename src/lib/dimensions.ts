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

export type SizeFitKind = "exact" | "bigger" | "unknown" | "smaller";

export interface SizeFit {
  kind: SizeFitKind;
  /** mm over ("bigger") or under ("smaller") what we asked, summed over the dimensions. 0 otherwise. */
  deltaMm: number;
}

/**
 * How a quoted piece compares with the inquiry size, IGNORING THE ORDER the
 * dimensions are written in: suppliers write 60 × 15 × 90 for our 15 × 60 × 90,
 * and a block is the same block either way. Sorting
 * both sets is also the right test for "can our part be cut from this piece".
 *   exact   — every dimension matches
 *   bigger  — nothing under size, something over: usable, needs machining down
 *   smaller — something is under size: the part cannot be made from it
 *   unknown — the supplier did not state (all of) the size
 */
export function sizeFit(
  inquiry: Array<string | null | undefined>,
  quoted: Array<string | null | undefined>,
  tolerance = 0.001
): SizeFit {
  const values = (xs: Array<string | null | undefined>) =>
    xs.map(dimValue).filter((v): v is number => v != null).sort((a, b) => a - b);
  const a = values(inquiry);
  const q = values(quoted);
  if (a.length === 0 && q.length === 0) return { kind: "exact", deltaMm: 0 };
  if (q.length === 0 || q.length !== a.length) return { kind: "unknown", deltaMm: 0 };

  let over = 0;
  let under = 0;
  a.forEach((v, i) => {
    const d = q[i] - v;
    if (d > tolerance) over += d;
    else if (d < -tolerance) under -= d;
  });
  const mm = (x: number) => Math.round(x * 100) / 100;
  if (under > 0) return { kind: "smaller", deltaMm: mm(under) };
  if (over > 0) return { kind: "bigger", deltaMm: mm(over) };
  return { kind: "exact", deltaMm: 0 };
}

/** "exact size", "bigger +1.5 mm", "too small −2 mm", "size not stated". */
export function sizeFitText(fit: SizeFit): string {
  switch (fit.kind) {
    case "exact": return "exact size";
    case "bigger": return `bigger +${fit.deltaMm} mm`;
    case "smaller": return `too small −${fit.deltaMm} mm`;
    default: return "size not stated";
  }
}

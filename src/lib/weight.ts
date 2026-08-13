/* Weight formulas — from the client's Excel ("Quotation Comparison (Material)",
 * rows 69–73):
 *
 *   Rectangular:  Weight (kg) = Thickness × Height × Length × 0.000008
 *   Round bar:    Weight (kg) = Ø² (mm²) × Length (mm) × 0.0000066
 *
 * The 0.000008 constant is density (8.0 g/cm³ — steel/stainless) × 1e-6.
 * The round constant 0.0000066 is the client's calibrated value for the same
 * density (≈ π/4 rounded to their margin). We reproduce the Excel EXACTLY for
 * steel, and scale both constants linearly by density for other materials:
 *   rectFactor  = ρ × 1e-6
 *   roundFactor = rectFactor × (0.0000066 / 0.000008)   // = ρ × 0.825e-6
 *
 * ⚠ Client-flagged: the Excel's worked example says "Ø50 × 200 = 303 kg";
 *   the correct result of their own formula is 3.3 kg (decimal typo in the
 *   sheet). This module returns 3.3.
 */

import { dimValue, isRoundItem } from "./dimensions";

const STEEL_DENSITY = 8.0;
const ROUND_RATIO = 0.0000066 / 0.000008; // 0.825, the Excel's round-vs-rect ratio

/** g/cm³ by material keyword. First match wins; default steel (Excel's constant). */
const DENSITY_RULES: Array<[RegExp, number | null]> = [
  // Plastics — no RM/kg normalisation (price per kg is meaningless across resins)
  [/PEEK|PTFE|TEFLON|PFA|ULTEM|PEI|DELRIN|NYLON|ACRYLIC|PERSPEX|POLYCARB|BAKELITE|RUBBER|SEMITRON|G10|HDPE|PET\b|PVC|VESPEL|\bPP\b|MONOCAST|THERMO|PLASTIC|\bPU\b|MC ?501/i, null],
  [/ALU|ALUMIN|5052|6061|7075|5083|5051/i, 2.7],
  [/BRASS|COPPER|BRONZE/i, 8.5],
  [/TITANIUM/i, 4.5],
  // Stainless / alloy / mild steel and everything else falls through to steel
];

/** Density (g/cm³) for a material string, or null when weight is meaningless. */
export function densityFor(materialType: string | null | undefined): number | null {
  const m = (materialType ?? "").trim();
  if (m === "") return STEEL_DENSITY;
  for (const [re, d] of DENSITY_RULES) {
    if (re.test(m)) return d;
  }
  return STEEL_DENSITY;
}

export interface ItemDims {
  materialType?: string | null;
  thicknessRaw?: string | null;
  heightRaw?: string | null;
  lengthRaw?: string | null;
}

/**
 * Weight in kg of ONE piece, or null when it can't be computed (missing dims
 * or a material with no meaningful density, e.g. plastics).
 *
 * Round bar (any dim carries Ø): Ø² × L × roundFactor. The diameter is the
 * first dim carrying Ø; the length is taken from the Length field when that
 * isn't the diameter, otherwise the last other populated dim.
 *
 * Both are selected by POSITION, never by string value: filtering by value
 * discards both dims when two happen to hold the same text (e.g. thickness and
 * length both "Ø50"), and picking the first remaining dim would read a Ø50 ×
 * h30 × l200 bar as 30mm long — under-weighing it by ~6.7×, which then feeds
 * RM/kg and the award recommendation.
 */
export function pieceWeightKg(item: ItemDims): number | null {
  const density = densityFor(item.materialType);
  if (density == null) return null;
  const rectFactor = density * 1e-6;

  const dims = [item.thicknessRaw, item.heightRaw, item.lengthRaw];
  const LENGTH_IDX = 2;
  const diaIdx = dims.findIndex((d) => isRoundItem(d));
  if (diaIdx !== -1) {
    const dia = dimValue(dims[diaIdx]);
    // Prefer the Length column; else the last other populated dim.
    let len: number | null = null;
    if (diaIdx !== LENGTH_IDX) len = dimValue(dims[LENGTH_IDX]);
    if (len == null) {
      for (let i = dims.length - 1; i >= 0; i--) {
        if (i === diaIdx) continue;
        const v = dimValue(dims[i]);
        if (v != null) { len = v; break; }
      }
    }
    if (dia == null || len == null) return null;
    return dia * dia * len * rectFactor * ROUND_RATIO;
  }

  const t = dimValue(item.thicknessRaw);
  const h = dimValue(item.heightRaw);
  const l = dimValue(item.lengthRaw);
  if (t == null || h == null || l == null) return null;
  return t * h * l * rectFactor;
}

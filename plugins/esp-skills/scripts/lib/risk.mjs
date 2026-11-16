// Risk levels of decisions, findings and runs, lowest first.

export const RISK_ORDER = ["low", "medium", "high"];

/** Return the higher of two risk levels (null-safe). */
export function maxRisk(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a;
}

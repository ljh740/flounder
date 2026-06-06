import type { AuditItem, Doc } from "../types.js";

export function halo2MissingConstraintSeeder(source: Doc[]): AuditItem[] {
  return [...halo2AdviceAssignmentSeeder(source), ...halo2AdviceBindingSeeder(source)];
}

export function halo2AdviceAssignmentSeeder(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const doc of source) {
    if (!doc.path.endsWith(".rs")) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!looksLikeUnconstrainedAssignment(line)) continue;

      const nearby = lines.slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 4)).join("\n");
      const hasLocalConstraint = /(copy_advice|constrain_equal|assert_equal|enable_equality|assign_advice_from_instance)/.test(nearby);
      const id = `halo2-missing-constraint-${items.length + 1}`;
      items.push({
        id,
        location: `${doc.path}:${idx + 1}`,
        securityProperty:
          "Every witness value used as a logical input to a circuit check must be enforced by visible circuit relations.",
        failureMode: "missing_constraint",
        why: hasLocalConstraint
          ? "This assignment is near equality-related code; verify how the value used downstream is enforced."
          : "This assigns witness advice without an obvious local equality/copy relation. Trace whether a malicious prover can choose a semantically inconsistent value.",
        attackerControlledInputs: ["private witness values assigned by the prover"],
        seeder: "halo2_missing_constraint",
      });
    }
  }
  return items;
}

export function halo2AdviceBindingSeeder(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const doc of source) {
    if (!doc.path.endsWith(".rs")) continue;
    const lines = doc.content.split(/\r?\n/);
    const assignments = lines
      .map((line, idx) => ({ line, lineNo: idx + 1, parsed: parseAssignAdvice(line) }))
      .filter(
        (entry): entry is { line: string; lineNo: number; parsed: AdviceAssignment } =>
          entry.parsed !== undefined && looksLikePointInputAssignment(entry.parsed),
      );

    for (let idx = 0; idx < assignments.length; idx += 1) {
      const current = assignments[idx];
      if (!current) continue;
      const group: Array<{ line: string; lineNo: number; parsed: AdviceAssignment }> = [current];
      while (idx + 1 < assignments.length) {
        const next = assignments[idx + 1];
        const last = group[group.length - 1];
        if (!next || !last || next.lineNo - last.lineNo > 4) break;
        idx += 1;
        group.push(next);
      }

      const first = group[0];
      const last = group[group.length - 1];
      if (!first || !last) continue;
      const start = first.lineNo;
      const end = last.lineNo;
      const context = windowText(lines, start, end, 25);
      const localContext = windowText(lines, start, end, 4);
      const functionName = functionNameNear(lines, start);
      if (!looksLikeHalo2BindingRisk(group.map((entry) => entry.parsed), context, functionName)) continue;
      if (hasDirectBinding(group.map((entry) => entry.parsed), localContext)) continue;

      const labels = group.map((entry) => entry.parsed.label).join(", ");
      const sources = group.map((entry) => entry.parsed.source).join(", ");
      const id = `halo2-advice-binding-${items.length + 1}`;
      items.push({
        id,
        location: `${doc.path}:${start}-${end}`,
        securityProperty:
          "Advice cells that stand in for logical inputs must be enforced by the downstream gates that rely on them.",
        failureMode: "missing_constraint",
        why:
          `This halo2 region assigns advice cells (${labels}) from witness values (${sources}) in a scalar/point dataflow context without a nearby copy/equality relation. ` +
          "Loop-internal constraints can make repeated advice cells equal to each other while still leaving an entry cell free to differ from a semantic input.",
        attackerControlledInputs: [
          "private witness values supplied by the prover",
          "intermediate advice cells used by scalar multiplication or point-binding gates",
        ],
        seeder: "halo2_advice_binding",
      });
    }
  }
  return items;
}

interface AdviceAssignment {
  label: string;
  column: string;
  source: string;
}

function parseAssignAdvice(line: string): AdviceAssignment | undefined {
  const match =
    /\.assign_advice\s*\(\s*\|\|\s*"([^"]+)"\s*,\s*([^,]+?)\s*,\s*[^,]+?\s*,\s*\|\|\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*\)\s*\??\s*;?/.exec(
      line,
    );
  if (!match) return undefined;
  return {
    label: match[1] ?? "advice",
    column: (match[2] ?? "").trim(),
    source: match[3] ?? "value",
  };
}

function looksLikeHalo2BindingRisk(assignments: AdviceAssignment[], context: string, functionName: string): boolean {
  const text = `${functionName}\n${context}`;
  const hasHalo2ScalarContext = /(scalar|mul|double|add|incomplete|base|q_mul|point|ecc)/i.test(text);
  const hasStructuredColumn = assignments.some((assignment) => /(^self\.|\.x_|\.y_|base|point|double_and_add)/i.test(assignment.column));
  const hasWitnessSource = assignments.some((assignment) => assignment.source.length > 0);
  return hasWitnessSource && hasHalo2ScalarContext && hasStructuredColumn;
}

function looksLikePointInputAssignment(assignment: AdviceAssignment): boolean {
  const text = `${assignment.label} ${assignment.column} ${assignment.source}`;
  return /\b(x_p|y_p|base_[xy]|point_[xy]|base|point)\b/i.test(text);
}

function hasDirectBinding(assignments: AdviceAssignment[], context: string): boolean {
  const labels = assignments.map((assignment) => escapeRegExp(assignment.label)).join("|");
  const sources = assignments.map((assignment) => escapeRegExp(assignment.source)).join("|");
  const bindingPattern = new RegExp(`(copy_advice|constrain_equal|assign_advice_from_instance)\\b[\\s\\S]{0,160}(${labels}|${sources})`, "i");
  return bindingPattern.test(context);
}

function functionNameNear(lines: string[], lineNo: number): string {
  for (let idx = Math.max(0, lineNo - 1); idx >= 0; idx -= 1) {
    const match = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/.exec(lines[idx] ?? "");
    if (match) return match[1] ?? "";
  }
  return "";
}

function windowText(lines: string[], startLine: number, endLine: number, radius: number): string {
  return lines.slice(Math.max(0, startLine - radius - 1), Math.min(lines.length, endLine + radius)).join("\n");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeUnconstrainedAssignment(line: string): boolean {
  return (
    /\bassign_advice\s*\(/.test(line) ||
    /\bassign_region\s*\(/.test(line) ||
    /\bValue::known\s*\(/.test(line)
  );
}

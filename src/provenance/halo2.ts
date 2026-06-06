import type { Doc, ProofObligation, ProvenanceFact, ProvenanceFactKind, ProvenanceGraph } from "../types.js";

const SIGNAL_TERMS = [
  "advice",
  "assignedcell",
  "base",
  "bit",
  "chip",
  "constraint",
  "copy",
  "gate",
  "instance",
  "mul",
  "point",
  "proof",
  "scalar",
  "selector",
  "witness",
  "x_p",
  "y_p",
];

export function extractHalo2Provenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeHalo2Doc(doc)) continue;
    files += 1;
    facts.push(...extractFactsFromDoc(doc));
  }
  const obligations = assignmentFlowObligations(facts);
  return {
    domain: "halo2",
    facts,
    obligations,
    summary: {
      files,
      facts: facts.length,
      byKind: countBy(facts, (fact) => fact.kind),
      assignmentFlowObligations: obligations.length,
    },
  };
}

export function renderProvenanceGraph(graph: ProvenanceGraph, limit = 80): string {
  if (graph.facts.length === 0 && graph.obligations.length === 0) return "";
  const facts = graph.facts
    .slice(0, limit)
    .map((fact) => {
      const details = [
        fact.functionName ? `fn=${fact.functionName}` : "",
        fact.label ? `label=${fact.label}` : "",
        fact.column ? `column=${fact.column}` : "",
        fact.rowExpression ? `row=${fact.rowExpression}` : "",
        fact.sourceExpression ? `source=${fact.sourceExpression}` : "",
        fact.receiver ? `receiver=${fact.receiver}` : "",
        fact.nearbySignals.length > 0 ? `signals=${fact.nearbySignals.join(",")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `- id=${fact.id} kind=${fact.kind} location=${fact.path}:${fact.line}${details ? ` ${details}` : ""}\n  code=${oneLine(fact.code)}`;
    })
    .join("\n");
  const obligations = graph.obligations
    .slice(0, Math.min(24, limit))
    .map((obligation) => `- id=${obligation.id} refs=${obligation.evidenceRefs.join("; ")} property=${oneLine(obligation.property)}`)
    .join("\n");
  return [
    `Domain: ${graph.domain}`,
    `Summary: facts=${graph.summary.facts} assignmentFlowObligations=${graph.summary.assignmentFlowObligations}`,
    obligations ? `Assignment-flow obligations:\n${obligations}` : "",
    facts ? `Facts:\n${facts}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractFactsFromDoc(doc: Doc): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const functionName = enclosingFunction(lines, idx);
    const nearbySignals = nearbySignalsFor(lines, idx);
    const fact = factFromLine(doc.path, idx + 1, line, functionName, nearbySignals);
    if (fact) out.push(fact);
  }
  return out;
}

function factFromLine(path: string, lineNumber: number, line: string, functionName: string | undefined, nearbySignals: string[]): ProvenanceFact | undefined {
  const code = line.trim();
  if (code.length === 0) return undefined;

  const assign = /\bassign_advice\s*\(\s*\|\|\s*"([^"]+)"\s*,\s*([^,]+),\s*([^,]+),\s*\|\|\s*([^)]+)\)/.exec(code);
  if (assign) {
    return fact({
      kind: "advice_assignment",
      path,
      line: lineNumber,
      functionName,
      label: assign[1],
      column: assign[2],
      rowExpression: assign[3],
      sourceExpression: assign[4],
      nearbySignals,
      code,
    });
  }

  const copy = /\b([A-Za-z_][A-Za-z0-9_().]*)\.copy_advice\s*\(\s*\|\|\s*"([^"]+)"\s*,\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/.exec(code);
  if (copy) {
    return fact({
      kind: "advice_copy",
      path,
      line: lineNumber,
      functionName,
      receiver: copy[1],
      label: copy[2],
      column: copy[4],
      rowExpression: copy[5],
      sourceExpression: copy[1],
      nearbySignals,
      code,
    });
  }

  if (/\bconstrain_equal\s*\(/.test(code)) {
    return fact({ kind: "equality_constraint", path, line: lineNumber, functionName, nearbySignals, code });
  }

  const equality = /\benable_equality\s*\(\s*([^)]+)\)/.exec(code);
  if (equality) {
    return fact({
      kind: "equality_enabled_column",
      path,
      line: lineNumber,
      functionName,
      column: equality[1],
      nearbySignals,
      code,
    });
  }

  if (/\bcreate_gate\s*\(/.test(code)) {
    return fact({ kind: "gate_creation", path, line: lineNumber, functionName, nearbySignals, code });
  }

  const query = /\bquery_(advice|instance|fixed|selector)\s*\(\s*([^,)]+)/.exec(code);
  if (query) {
    return fact({
      kind: query[1] === "selector" ? "selector" : "gate_query",
      path,
      line: lineNumber,
      functionName,
      column: query[2],
      nearbySignals,
      code,
    });
  }

  if (/\bselector\b|q_[A-Za-z0-9_]+/.test(code)) {
    return fact({ kind: "selector", path, line: lineNumber, functionName, nearbySignals, code });
  }

  return undefined;
}

function assignmentFlowObligations(facts: ProvenanceFact[]): ProofObligation[] {
  return facts
    .filter((fact) => fact.kind === "advice_assignment")
    .filter((fact) => fact.nearbySignals.some((signal) => ["base", "mul", "point", "proof", "scalar", "witness", "x_p", "y_p"].includes(signal)))
    .slice(0, 48)
    .map((fact) => ({
      id: `halo2-assignment-flow-${slug(fact.path)}-${fact.line}`,
      kind: "provenance" as const,
      property: "Security-relevant assigned values should have a visible path from assignment through the circuit checks that rely on them.",
      rationale:
        "This is a provenance obligation, not a finding: the model should enumerate a source-backed audit item only if the loaded code and reference material make this assignment security-relevant.",
      evidenceRefs: [`${fact.path}:${fact.line}`],
      keywords: ["assignment", "constraint", "dataflow", "witness"],
    }));
}

function fact(input: {
  kind: ProvenanceFactKind;
  path: string;
  line: number;
  functionName?: string | undefined;
  label?: string | undefined;
  column?: string | undefined;
  rowExpression?: string | undefined;
  sourceExpression?: string | undefined;
  receiver?: string | undefined;
  nearbySignals: string[];
  code: string;
}): ProvenanceFact {
  return {
    id: `${input.kind}-${slug(input.path)}-${input.line}`,
    domain: "halo2",
    kind: input.kind,
    path: input.path,
    line: input.line,
    ...(input.functionName ? { functionName: input.functionName } : {}),
    ...(input.label ? { label: input.label.trim() } : {}),
    ...(input.column ? { column: input.column.trim() } : {}),
    ...(input.rowExpression ? { rowExpression: input.rowExpression.trim() } : {}),
    ...(input.sourceExpression ? { sourceExpression: input.sourceExpression.trim() } : {}),
    ...(input.receiver ? { receiver: input.receiver.trim() } : {}),
    nearbySignals: input.nearbySignals,
    code: input.code,
  };
}

function looksLikeHalo2Doc(doc: Doc): boolean {
  const text = doc.content.toLowerCase();
  return (
    doc.path.endsWith(".rs") &&
    (text.includes("assign_advice") ||
      text.includes("copy_advice") ||
      text.includes("create_gate") ||
      text.includes("query_advice") ||
      text.includes("assignedcell") ||
      text.includes("halo2"))
  );
}

function nearbySignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 4);
  const end = Math.min(lines.length, idx + 5);
  const text = lines.slice(start, end).join("\n").toLowerCase();
  return SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 10);
}

function enclosingFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 80; pos -= 1) {
    const match = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/.exec(lines[pos] ?? "");
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "fact";
}

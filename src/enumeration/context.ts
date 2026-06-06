import type { AuditorConfig } from "../config.js";
import { assemble } from "../ingest/source.js";
import { type ContextSlice, renderContextSlices, SourceIndex } from "../index/source-index.js";
import { retrieveWithQmd, type QmdRetrievalResult } from "../retrieval/qmd.js";
import type { AuditItem, Doc, ProofObligation, ProvenanceGraph } from "../types.js";
import { parseLocationRanges } from "../util/location.js";

export interface EnumerationContextResult {
  corpus: string;
  source: string;
  trace: {
    round: number;
    mode: AuditorConfig["contextRetrieval"];
    budget: number;
    selectedBudget: number;
    overviewBudget: number;
    usedChars: number;
    truncated: boolean;
    obligations: number;
    provenanceFacts: number;
    slices: Array<{
      path: string;
      startLine: number;
      endLine: number;
      reason: string;
      chars: number;
      included: boolean;
    }>;
    qmd?: {
      available: boolean;
      queries: number;
      hits: number;
      collections: string[];
      errors: string[];
    };
  };
}

export async function buildEnumerationContext(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  sourceIndex: SourceIndex;
  proofObligations: ProofObligation[];
  provenanceGraphs: ProvenanceGraph[];
  round: number;
}): Promise<EnumerationContextResult> {
  const corpusBudget = Math.floor(input.cfg.contextCharBudget / 2);
  const sourceBudget = Math.floor(input.cfg.contextCharBudget / 2);
  const selectedBudget = Math.max(4_000, Math.floor(sourceBudget * 0.7));
  const selectedSlices = [
    ...mergeContextSlices(contextSlicesForProvenance(input.provenanceGraphs, input.sourceIndex)),
    ...mergeContextSlices(contextSlicesForObligations(input.proofObligations, input.sourceIndex)),
  ];
  const qmd = await retrieveEnumerationQmd(input);
  selectedSlices.push(...mergeContextSlices(qmd.flatMap((result) => result.slices)));

  const selectedTrace = renderContextSlices(selectedSlices, selectedBudget);
  const overviewBudget = Math.max(0, sourceBudget - selectedTrace.usedChars);
  const overview = overviewBudget > 1000 ? assemble(input.source, overviewBudget, true) : "";
  const source = [selectedTrace.context, overview ? `\n===== SOURCE OVERVIEW =====\n${overview}` : ""].filter(Boolean).join("\n");
  const usedChars = selectedTrace.usedChars + overview.length;
  return {
    corpus: assemble(input.corpus, corpusBudget),
    source: source || assemble(input.source, sourceBudget, true),
    trace: {
      round: input.round,
      mode: input.cfg.contextRetrieval,
      budget: sourceBudget,
      selectedBudget,
      overviewBudget,
      usedChars,
      truncated: selectedTrace.truncated || overview.length >= overviewBudget,
      obligations: input.proofObligations.length,
      provenanceFacts: input.provenanceGraphs.reduce((sum, graph) => sum + graph.facts.length, 0),
      slices: selectedTrace.slices,
      ...(qmd.length > 0 ? { qmd: summarizeQmd(qmd) } : {}),
    },
  };
}

function contextSlicesForObligations(obligations: ProofObligation[], index: SourceIndex): ContextSlice[] {
  const out: ContextSlice[] = [];
  for (const obligation of obligations.slice(0, 80)) {
    for (const ref of obligation.evidenceRefs.slice(0, 4)) {
      for (const range of parseLocationRanges(ref)) {
        const doc = index.findDoc(range.pathHint);
        if (!doc) continue;
        out.push({
          doc,
          startLine: Math.max(1, range.startLine - 35),
          endLine: range.endLine + 45,
          reason: `proof obligation ${obligation.id}`,
        });
      }
    }
  }
  return out;
}

function contextSlicesForProvenance(graphs: ProvenanceGraph[], index: SourceIndex): ContextSlice[] {
  const out: ContextSlice[] = [];
  for (const graph of graphs) {
    const facts = rankProvenanceFacts(graph).slice(0, 120);
    for (const fact of facts) {
      const doc = index.findDoc(fact.path);
      if (!doc) continue;
      out.push({
        doc,
        startLine: Math.max(1, fact.line - 45),
        endLine: fact.line + 70,
        reason: `${graph.domain} provenance ${fact.kind}`,
      });
    }
  }
  return out;
}

function mergeContextSlices(slices: ContextSlice[]): ContextSlice[] {
  const grouped = new Map<string, ContextSlice[]>();
  for (const slice of slices) {
    const key = slice.doc.path;
    const group = grouped.get(key) ?? [];
    group.push(slice);
    grouped.set(key, group);
  }

  const out: ContextSlice[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    for (const slice of sorted) {
      const last = out[out.length - 1];
      if (last && last.doc.path === slice.doc.path && slice.startLine <= last.endLine + 20) {
        last.endLine = Math.max(last.endLine, slice.endLine);
        last.reason = mergeReasons(last.reason, slice.reason);
        continue;
      }
      out.push({ ...slice });
    }
  }
  return out;
}

function mergeReasons(a: string, b: string): string {
  if (a === b) return a;
  const parts = [...new Set([...a.split("; "), ...b.split("; ")])];
  return parts.slice(0, 3).join("; ");
}

async function retrieveEnumerationQmd(input: {
  cfg: AuditorConfig;
  source: Doc[];
  proofObligations: ProofObligation[];
  provenanceGraphs: ProvenanceGraph[];
}): Promise<QmdRetrievalResult[]> {
  if (input.cfg.contextRetrieval !== "source-index+qmd") return [];
  const probes = qmdProbeItems(input.proofObligations, input.provenanceGraphs).slice(0, 8);
  const out: QmdRetrievalResult[] = [];
  for (const probe of probes) {
    out.push(
      await retrieveWithQmd(probe, input.source, {
        command: input.cfg.qmdCommand,
        limit: Math.max(1, Math.ceil(input.cfg.qmdLimit / 2)),
        minScore: input.cfg.qmdMinScore,
        timeoutMs: input.cfg.qmdTimeoutMs,
        collections: input.cfg.qmdCollections,
      }),
    );
  }
  return out;
}

function qmdProbeItems(obligations: ProofObligation[], graphs: ProvenanceGraph[]): AuditItem[] {
  const fromObligations = obligations
    .filter((obligation) => obligation.evidenceRefs.some((ref) => ref.includes(":")))
    .slice(0, 4)
    .map((obligation): AuditItem => ({
      id: `enum-qmd-${obligation.id}`,
      location: obligation.evidenceRefs[0] ?? "source",
      securityProperty: obligation.property,
      failureMode: "missing_constraint",
      why: obligation.rationale,
    }));
  const fromProvenance = graphs
    .flatMap((graph) => graph.obligations)
    .slice(0, 4)
    .map((obligation): AuditItem => ({
      id: `enum-qmd-${obligation.id}`,
      location: obligation.evidenceRefs[0] ?? "source",
      securityProperty: obligation.property,
      failureMode: "missing_constraint",
      why: obligation.rationale,
    }));
  return [...fromObligations, ...fromProvenance];
}

function rankProvenanceFacts(graph: ProvenanceGraph): ProvenanceGraph["facts"] {
  return [...graph.facts].sort((a, b) => scoreFact(b) - scoreFact(a));
}

function scoreFact(fact: ProvenanceGraph["facts"][number]): number {
  const kindScore: Record<string, number> = {
    advice_assignment: 100,
    advice_copy: 80,
    equality_constraint: 70,
    gate_creation: 65,
    gate_query: 55,
    selector: 45,
    equality_enabled_column: 35,
  };
  return (kindScore[fact.kind] ?? 0) + fact.nearbySignals.length * 3;
}

function summarizeQmd(results: QmdRetrievalResult[]): NonNullable<EnumerationContextResult["trace"]["qmd"]> {
  return {
    available: results.some((result) => result.available),
    queries: results.length,
    hits: results.reduce((sum, result) => sum + result.hits.length, 0),
    collections: [...new Set(results.flatMap((result) => result.collections))],
    errors: results.flatMap((result) => (result.error ? [result.error] : [])).slice(0, 4),
  };
}

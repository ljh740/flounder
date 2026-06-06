import type { Doc, ProjectLearning, ProofObligation, ProvenanceGraph } from "../types.js";

const MAX_DOC_OBLIGATIONS = 48;
const MAX_LEARNING_OBLIGATIONS = 24;
const MAX_PROVENANCE_OBLIGATIONS = 48;

const SECURITY_TERMS = [
  "balance",
  "bind",
  "binding",
  "check",
  "constrain",
  "constraint",
  "equal",
  "enforce",
  "integrity",
  "nullifier",
  "proof",
  "soundness",
  "unique",
  "verify",
  "witness",
];

const NORMATIVE_OR_SECURITY_RE = new RegExp(
  [
    "\\bmust\\b",
    "\\bshall\\b",
    "\\bshould\\b",
    "\\brequired\\b",
    "\\brequires\\b",
    "\\bchecks?\\b",
    "\\bconstrain(?:s|ed|ing)?\\b",
    "\\benforce(?:s|d|ment)?\\b",
    "\\bprove(?:s|d)?\\b",
    "\\bverify(?:ies|ing)?\\b",
    "\\bnullifier\\b",
    "\\bbalance\\b",
    "\\bsoundness\\b",
    "[A-Za-z0-9_.'\\[\\]{}^+-]+\\s*=\\s*[A-Za-z0-9_.'\\[\\]{}^+-]+",
  ].join("|"),
  "i",
);

export function extractProofObligations(input: {
  source: Doc[];
  corpus: Doc[];
  projectLearning?: ProjectLearning;
  provenanceGraphs?: ProvenanceGraph[];
}): ProofObligation[] {
  const out: ProofObligation[] = [];
  out.push(...extractDocObligations(input.corpus, "spec", MAX_DOC_OBLIGATIONS));
  out.push(...extractDocObligations(input.source, "source", Math.floor(MAX_DOC_OBLIGATIONS / 2)));
  out.push(...extractLearningObligations(input.projectLearning));
  for (const graph of input.provenanceGraphs ?? []) {
    out.push(...graph.obligations.slice(0, MAX_PROVENANCE_OBLIGATIONS));
  }
  return dedupeObligations(out).slice(0, 120);
}

export function renderProofObligations(obligations: ProofObligation[], limit = 60): string {
  return obligations
    .slice(0, limit)
    .map((obligation) => {
      const refs = obligation.evidenceRefs.length > 0 ? ` refs=${obligation.evidenceRefs.join("; ")}` : "";
      const keywords = obligation.keywords && obligation.keywords.length > 0 ? ` keywords=${obligation.keywords.join(",")}` : "";
      return `- id=${obligation.id} kind=${obligation.kind}${refs}${keywords}\n  property=${oneLine(obligation.property)}\n  rationale=${oneLine(obligation.rationale)}`;
    })
    .join("\n");
}

function extractDocObligations(docs: Doc[], kind: ProofObligation["kind"], limit: number): ProofObligation[] {
  const out: ProofObligation[] = [];
  for (const doc of docs) {
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length && out.length < limit; idx += 1) {
      const line = compactLine(lines[idx] ?? "");
      if (!isObligationLike(line)) continue;
      const keywords = keywordsFor(line);
      out.push({
        id: `${kind}-${slug(doc.path)}-${idx + 1}`,
        kind,
        property: line,
        rationale: "Reference material or source text states a property that later audit items should connect to implementation evidence.",
        evidenceRefs: [`${doc.path}:${idx + 1}`],
        ...(keywords.length > 0 ? { keywords } : {}),
      });
    }
  }
  return out;
}

function extractLearningObligations(projectLearning: ProjectLearning | undefined): ProofObligation[] {
  if (!projectLearning) return [];
  const notes = [
    ...(projectLearning.securityObjectives ?? []),
    ...(projectLearning.candidateInvariants ?? []),
    ...(projectLearning.implementationMechanics ?? []),
  ];
  return notes
    .map((note, idx) => compactLine(note))
    .filter((note) => note.length > 0)
    .slice(0, MAX_LEARNING_OBLIGATIONS)
    .map((note, idx) => {
      const keywords = keywordsFor(note);
      return {
        id: `learning-${idx + 1}-${slug(note)}`,
        kind: "learning" as const,
        property: note,
        rationale: "Model initialization learned this candidate invariant from the loaded material; enumeration should turn it into source-backed audit items when possible.",
        evidenceRefs: projectLearning.evidenceRefs ?? [],
        ...(keywords.length > 0 ? { keywords } : {}),
      };
    });
}

function dedupeObligations(obligations: ProofObligation[]): ProofObligation[] {
  const seen = new Set<string>();
  const out: ProofObligation[] = [];
  for (const obligation of obligations) {
    const key = `${obligation.kind}:${obligation.property.toLowerCase()}:${obligation.evidenceRefs.join(";").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(obligation);
  }
  return out;
}

function isObligationLike(line: string): boolean {
  if (line.length < 20 || line.length > 360) return false;
  if (/^(\/\/|#|\*)?\s*(todo|fixme)\b/i.test(line)) return false;
  return NORMATIVE_OR_SECURITY_RE.test(line);
}

function keywordsFor(input: string): string[] {
  const lowered = input.toLowerCase();
  return SECURITY_TERMS.filter((term) => lowered.includes(term)).slice(0, 8);
}

function compactLine(input: string): string {
  return input
    .replace(/^\s*(\/\/+|#|\*+)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return cleaned || "obligation";
}

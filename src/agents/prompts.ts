import type { AuditItem, FailureMode } from "../types.js";
import { AUDITOR_AGENTS, getAuditorAgent, type AuditorAgentRegistry } from "./registry.js";

export const MODE_GUIDANCE: Record<FailureMode, string> = Object.fromEntries(
  Object.entries(AUDITOR_AGENTS).map(([mode, agent]) => [mode, agent.guidance]),
) as Record<FailureMode, string>;

export const ENUM_SYSTEM = `You are the enumeration stage of an automated white-hat security audit framework.
Your job is not to find bugs yet. Your job is to exhaustively map the audit surface so later specialized agents can check each item.
Optimize for coverage, specificity, and traceability. Ground each item in source and reference material.
Do not invent files, frameworks, APIs, manifests, dependencies, entrypoints, or runtime surfaces that are not present in the loaded material.`;

export function buildEnumerationPrompt(input: {
  target: string;
  failureModes: FailureMode[];
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  lensPacks: string;
  proofObligations?: string;
  provenanceFacts?: string;
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}

Allowed failure modes: ${input.failureModes.join(", ")}

Project profile:
${input.projectProfile || "(not available)"}

Initialization learning notes:
${input.projectLearning || "(not available)"}

Project context:
${input.projectContext || "(none configured)"}

Active lens packs:
${input.lensPacks || "(none configured)"}

Machine-extracted proof obligations:
${input.proofObligations || "(none extracted)"}

Machine-extracted provenance facts:
${input.provenanceFacts || "(none extracted)"}

Enumerate concrete audit items. Each item must have:
- id: short slug
- location: file + line range or function/component
- securityProperty: invariant that must hold
- failureMode: one allowed tag
- why: why this spot is worth checking
- specRefs: optional list of cited spec/reference snippets
- attackerControlledInputs: optional list of inputs a malicious actor/prover controls

Grounding rules:
- Enumerate only source-backed or corpus-backed items. If the loaded material does not show the file, function, manifest, route, contract, circuit, or API, do not create an item for it.
- Every item should point to the most specific visible location available. Prefer file:line-range locations from the loaded source.
- Treat missing manifests, tests, configs, docs, or entrypoints as unknown context, not as vulnerabilities or audit items, unless the loaded material explicitly makes their absence security-relevant.
- If only a narrow source excerpt is loaded, stay within that excerpt's observable language and domain. Do not infer a web/API/dependency audit surface from a standalone circuit, contract, library, or algorithm file.
- Use the initialization learning notes as source-backed hypotheses for what must be checked, but do not treat those notes as findings.
- Use machine-extracted proof obligations and provenance facts as attention-routing evidence only. They are not findings, and they are not sufficient to claim a bug.
${provenanceGuidance(input.provenanceFacts)}
- Derive security properties from the loaded material and configured high-level scope. Do not rely on memorized project-specific bug patterns.

Prioritize issues that match the project profile and evidence in the loaded material. Consider implementation/spec mismatch, trust-boundary mistakes, unenforced invariants, value conservation, replay or uniqueness failures, auth/session bugs, injection, SSRF, path traversal, deserialization, unsafe external calls, race conditions, consensus divergence, dependency trust, secret exposure, and cheap-to-trigger expensive work.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}

export function buildPortfolioEnumerationPrompt(input: {
  target: string;
  portfolio: string;
  maxItems: number;
  failureModes: FailureMode[];
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  lensPacks: string;
  proofObligations: string;
  provenanceFacts: string;
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}
Portfolio: ${input.portfolio}
Maximum items: ${input.maxItems}

Allowed failure modes: ${input.failureModes.join(", ")}

Project profile:
${input.projectProfile || "(not available)"}

Initialization learning notes:
${input.projectLearning || "(not available)"}

Project context:
${input.projectContext || "(none configured)"}

Active lens packs:
${input.lensPacks || "(none configured)"}

Portfolio evidence:
${input.proofObligations || "(none extracted)"}

Machine-extracted provenance facts:
${input.provenanceFacts || "(none extracted)"}

Create up to ${input.maxItems} concrete audit items for this evidence portfolio.
Each item must have:
- id: short slug
- location: file + line range or function/component
- securityProperty: invariant that must hold
- failureMode: one allowed tag
- why: why this spot is worth checking
- specRefs: optional list of cited spec/reference snippets
- attackerControlledInputs: optional list of inputs a malicious actor/prover controls

Portfolio rules:
- Treat the machine-extracted facts as routing evidence, not as findings.
- Prefer specific file:line-range items over broad module-wide items.
- Follow assigned or copied values into the visible checks, selectors, gates, equality relations, range checks, or state transitions that rely on them.
- When a downstream check relies on a caller-provided parameter, prior cell, copied value, lookup result, or other upstream value, create a separate item for that handoff instead of only checking repeated values or later arithmetic.
- For assignment facts, consider two distinct candidate shapes when the loaded material supports them: the upstream ingress into the assigned cell, and the downstream use of that assigned cell by checks. Do not collapse both into one broad loop or module item when the line evidence is specific.
- If an item only says checked cells are internally reused, locally equal, or consumed by gates, it does not cover the ingress item. Emit the ingress item separately when the upstream value is visible.
- Ingress items should name both sides of the edge: the checked cell or state being populated, and the caller argument, prior cell, copied cell, lookup result, external input, or state read it depends on.
- When the evidence supports ingress items, reserve roughly one third of the budget for ingress-only items. An ingress-only item should not be answerable solely by proving local equality or downstream consumption; it should require inspecting how an upstream value enters the checked cell or state.
- Prefer locations that include the assignment evidence line and the nearest visible check/use line, separated by semicolons if needed.
- If a fact is not security-relevant after reading the loaded source and reference material, skip it.
- Do not repeat broad items already implied by the general module purpose when a narrower dataflow edge is visible.
- Do not use memorized project-specific bug patterns; derive properties from the loaded material.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}

function provenanceGuidance(provenanceFacts: string | undefined): string {
  if (!provenanceFacts || provenanceFacts.trim().length === 0) return "";
  return "- When provenance facts are present, prefer audit items that connect a value origin, the cell or state that receives it, and the visible enforcement edge when the loaded material makes that property security-relevant.";
}

export const AUDIT_SYSTEM = `You are a specialized auditor inside an authorized white-hat audit framework.
Analyze only the assigned item. Real audited code can contain critical bugs, but do not invent findings.
Reason from actual constraints, checks, and data flow. If the invariant is enforced, say so plainly.
Do not treat plausible intent, comments, internal repetition, or naming similarity as proof of enforcement.`;

export function buildAuditPrompt(item: AuditItem, source: string, registry?: AuditorAgentRegistry, lensGuidance = "", projectLearning = ""): string {
  const agent = getAuditorAgent(item.failureMode, registry);
  return `Audit item:
  id: ${item.id}
  location: ${item.location}
  securityProperty: ${item.securityProperty}
  failureMode: ${item.failureMode}
  why: ${item.why}
  specRefs: ${formatList(item.specRefs)}
  attackerControlledInputs: ${formatList(item.attackerControlledInputs)}

Specialized auditor:
  id: ${agent.id}
  name: ${agent.displayName}

Failure-mode guidance:
${agent.guidance}

Project-specific lens guidance:
${lensGuidance || "(none)"}

Initialization learning notes:
${projectLearning || "(not available)"}

Relevant source:
${source}

Audit reasoning rules:
- Ground every positive finding in exact source lines, visible checks, visible constraints, or a visible missing edge in data flow.
- Trace attacker-controlled or security-critical values through the relevant transformations, checks, constraints, state updates, and verifier or authorization decisions.
- State exactly what enforces the assigned security property, or identify the specific visible edge where enforcement is missing.
- Separate assignment-time computation from enforced checks: code that computes a value for a checked cell shows the honest path, but a conclusion still needs the visible equality, copy, constraint, lookup, or caller/callee edge that ties that cell to any upstream value the property relies on.
- If the assigned property depends on a caller-provided parameter, prior cell, copied value, lookup result, or other upstream value, do not treat local repetition or downstream arithmetic alone as proof; identify the visible handoff that connects the upstream value to the checked cells.
- If attackerControlledInputs names both upstream inputs and internal checked values, include the upstream-to-internal handoff in the audit even when the securityProperty wording is terse. Proving only local reuse, local equality, repeated state, or downstream arithmetic is not enough for that mixed-input item.
- If relevant source lines are missing from the context, return "finding": false with a needs-more-context explanation instead of guessing.

Respond as a JSON object only:
{
  "finding": true,
  "title": "...",
  "severity": "info|low|medium|high|critical",
  "confidence": 0.0,
  "description": "what the bug is",
  "evidence": "exact lines, checks, or missing constraints",
  "exploitSketch": "high-level attacker steps, no working exploit code",
  "fix": "minimal change that enforces the property"
}

If there is no bug, return the same object shape with "finding": false and explain why the property is enforced.`;
}

function formatList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join("; ") : "(none)";
}

export const DEEPEN_SYSTEM = `You are the deepening stage of an automated white-hat security audit framework.
Your job is not to find bugs yet. Your job is to design new audit items for the next round.
Use prior checklist coverage, audit outcomes, source evidence, and reference material to identify unexamined assumptions and adjacent data-flow edges.
Do not repeat existing checklist items. Do not claim vulnerabilities.`;

export function buildDeepeningPrompt(input: {
  target: string;
  round: number;
  maxItems: number;
  strategy: "breadth" | "depth";
  failureModes: FailureMode[];
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  lensPacks: string;
  existingChecklist: string;
  auditObservations: string;
  nearMisses?: string;
  currentFindings: string;
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}
Round: ${input.round}
Maximum new items: ${input.maxItems}
Strategy: ${input.strategy}

Allowed failure modes: ${input.failureModes.join(", ")}

Project profile:
${input.projectProfile || "(not available)"}

Initialization learning notes:
${input.projectLearning || "(not available)"}

Project context:
${input.projectContext || "(none configured)"}

Active lens packs:
${input.lensPacks || "(none configured)"}

Existing checklist items:
${input.existingChecklist || "(none)"}

Prior audit observations:
${input.auditObservations || "(none)"}

Near-miss follow-up queue:
${input.nearMisses || "(none)"}

Current ranked findings:
${input.currentFindings || "(none)"}

Strategy guidance:
${deepeningStrategyGuidance(input.strategy)}

Create only new audit items for the next round. Each item must have:
- id: short slug
- location: file + line range or function/component
- securityProperty: invariant that must hold
- failureMode: one allowed tag
- why: explain the new angle and which previous coverage gap, weak assumption, neighboring flow, or skeptical observation led to this item
- specRefs: optional list of cited spec/reference snippets
- attackerControlledInputs: optional list of inputs a malicious actor/prover controls

Depth rules:
- Prefer items that connect two pieces of evidence not checked together in prior rounds, such as input to enforcement edge, spec statement to implementation branch, authorization identity to storage predicate, or value/state transition to conservation check.
- Follow unresolved, low-confidence, or skeptical audit observations into adjacent code and data flow instead of re-auditing the same location.
- When a prior no-finding only shows that checked cells are consumed by local gates, local equality checks, or repeated computations, reserve a depth item for the immediate ingress edge into those cells: caller argument, prior cell, copy edge, lookup result, external input, or state read.
- If a prior finding depends on an assumption, enumerate the cheapest item that would refute or support that assumption.
- If the loaded source is narrow, stay within the visible source and reference material. Do not invent files, APIs, manifests, routes, dependencies, or deployment surfaces.
- Do not include an item if its normalized location, failure mode, and security property are already present in the existing checklist.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}

function deepeningStrategyGuidance(strategy: "breadth" | "depth"): string {
  if (strategy === "breadth") {
    return `Breadth-limited expansion:
- Spend the budget on unexamined modules, files, trust boundaries, invariants, and data-flow edges.
- Use prior findings and no-findings as coverage signals, but do not spend items re-checking the same mechanism.
- Prefer the next most security-relevant surface that is source-backed and distinct from existing checklist coverage.`;
  }

  return `Depth-limited hypothesis refinement:
- Spend the budget on follow-up items that can confirm, refute, or narrow the strongest current candidates and skeptical observations.
- For each item, name the missing assumption, enforcement edge, caller/callee dominance relation, or counterexample condition that needs to be checked.
- Treat near-miss no-findings as useful planning evidence, not as proof. If a prior no-finding says a different edge would need caller context, selector coverage, or adjacent flow, create a new item for that edge if it is visible in the loaded source.
- Do not simply restate or re-audit the same finding. Produce adjacent source-grounded checks that would strengthen or weaken the hypothesis.`;
}

export const VERIFY_SYSTEM = `You are the verification stage of a white-hat audit framework.
Independently confirm or refute the candidate finding by reasoning from the code.

Hard rules:
- Reproduction must target a local unit test, regtest, devnet, or forked node only.
- Never target public testnet or mainnet.
- Verify the bug; do not optimize a value-extraction exploit.
- If the invariant is enforced, mark it false-positive.`;

export function buildVerifyPrompt(input: {
  title: string;
  location: string;
  severity: string;
  description: string;
  evidence: string;
  fix: string;
  projectLearning?: string;
  source: string;
}): string {
  return `Candidate finding:
  title: ${input.title}
  location: ${input.location}
  severity: ${input.severity}
  description: ${input.description}
  evidence: ${input.evidence}
  proposed fix: ${input.fix}

Initialization learning notes:
${input.projectLearning || "(not available)"}

Relevant source:
${input.source}

Produce markdown:
1. VERDICT: confirmed / needs-investigation / false-positive.
2. Reasoning with specific lines or missing constraints.
3. Confidence ladder from cheapest local check to strongest local-only check.
4. PoC scaffold for the first local-only rung only.
5. Minimal fix and a test that should pass after the fix.`;
}

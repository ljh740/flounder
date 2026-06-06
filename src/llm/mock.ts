import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

export class MockAuditLlmClient implements LlmClient {
  constructor(private logger?: RunLogger) {}

  setLogger(logger: RunLogger): void {
    this.logger = logger;
  }

  async complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  }): Promise<string> {
    const response = responseFor(input.tag, input.user);
    await this.logger?.call({
      tag: input.tag,
      model: input.model ?? "mock",
      system: input.system,
      user: input.user,
      response,
      meta: { mock: true },
    });
    return response;
  }
}

function responseFor(tag: string, user: string): string {
  if (tag === "learn_project") {
    return JSON.stringify({
      scopeSummary: "Mock initialization notes for a small source set with circuit-like checks.",
      securityObjectives: ["Checked statements should enforce the properties they rely on."],
      domainConcepts: ["assigned values", "verification checks", "local enforcement edges"],
      trustBoundaries: ["prover-controlled data entering trusted verification logic"],
      attackerCapabilities: ["choose private inputs or other values accepted by the checked code"],
      candidateInvariants: ["Values that affect a verified statement should be enforced by visible checks or equations."],
      implementationMechanics: ["Some source locations assign values before later checks use them."],
      uncertainty: ["Mock learning is only a deterministic test fixture."],
      evidenceRefs: ["fixtures"],
    });
  }

  if (tag === "discover_lenses") {
    return JSON.stringify([
      {
        id: "mock-project-lens",
        displayName: "Mock Project Lens",
        description: "Mock lens pack used to test model-generated project reconnaissance.",
        projectContext: {
          criticalAssets: ["verified statement integrity"],
          attackerCapabilities: ["choose private values accepted by the checked code"],
          securityInvariants: ["properties relied on by checks must be visibly enforced"],
        },
        failureModes: ["missing_constraint"],
        enumerationGuidance: ["Map values used by checks to the code that enforces them."],
        auditGuidance: ["Identify the visible enforcement edge before claiming a missing constraint."],
      },
    ]);
  }

  if (tag === "enumerate") {
    return JSON.stringify([
      {
        id: "mock-balance-integrity",
        location: "fixtures/halo2_missing_constraint.rs:5",
        securityProperty: "Values used by a verified statement must be enforced before downstream checks rely on them.",
        failureMode: "missing_constraint",
        why: "Mock enumeration item used to test end-to-end model-driven audit flow.",
        attackerControlledInputs: ["private value assignment"],
      },
    ]);
  }

  if (tag === "enumerate_assignment_dataflow") {
    return JSON.stringify([
      {
        id: "mock-assignment-dataflow",
        location: "fixtures/halo2_scalar_mul_binding.rs:13-14",
        securityProperty: "Assigned values used by checked logic must have a visible enforcement path.",
        failureMode: "missing_constraint",
        why: "Mock portfolio item used to test focused evidence-portfolio enumeration.",
        attackerControlledInputs: ["private value assignment"],
      },
    ]);
  }

  if (tag === "deepen_round_2" || tag === "deepen_round_2_breadth") {
    return JSON.stringify([
      {
        id: "mock-round-2-enforcement-edge",
        location: "fixtures/halo2_scalar_mul_binding.rs:13-14",
        securityProperty: "Neighboring values used by the same checked computation must have a visible enforcement edge.",
        failureMode: "missing_constraint",
        why: "Round 2 follows prior coverage into a neighboring data-flow edge that was not checked by the initial checklist.",
        attackerControlledInputs: ["private values used by the checked computation"],
      },
    ]);
  }

  if (tag === "deepen_round_2_depth") {
    return JSON.stringify([
      {
        id: "mock-round-2-proof-obligation",
        location: "fixtures/halo2_missing_constraint.rs:5-9",
        securityProperty: "The candidate missing-constraint hypothesis must be refuted or confirmed by checking the exact enforcement edge used by downstream logic.",
        failureMode: "missing_constraint",
        why: "Depth strategy follows the top candidate into the cheapest source-backed proof obligation instead of broadening to another module.",
        attackerControlledInputs: ["private value assignment"],
      },
    ]);
  }

  if (tag.startsWith("audit_")) {
    const hasMissingConstraintShape = /assign_advice|missing_constraint|witness advice/i.test(user);
    return JSON.stringify({
      finding: hasMissingConstraintShape,
      title: hasMissingConstraintShape ? "Assigned value can affect checked logic without visible enforcement" : "No finding",
      severity: hasMissingConstraintShape ? "high" : "info",
      confidence: hasMissingConstraintShape ? 0.82 : 0.2,
      description: hasMissingConstraintShape
        ? "The assigned value is treated as a logical input but the local context does not show an enforcement edge before downstream checks rely on it."
        : "The mocked auditor did not detect the target bug shape.",
      evidence: hasMissingConstraintShape
        ? "The source context contains assign_advice calls without a nearby copy_advice/constrain_equal chain in the vulnerable function."
        : "No matching evidence in mock response.",
      exploitSketch: hasMissingConstraintShape
        ? "A malicious prover could choose a different private value while satisfying downstream checks that assume the property was enforced."
        : "",
      fix: hasMissingConstraintShape
        ? "Add an explicit constraint or equivalent enforcement edge before the downstream check relies on the value."
        : "",
    });
  }

  if (tag.startsWith("verify_")) {
    return `1. VERDICT: needs-investigation

The mock verifier confirms the framework path only. A real verifier must inspect the target circuit and write a local unit test.

2. Confidence ladder

- Local gadget unit test that mutates the witness assignment.
- Component proof test in the target circuit.
- Local regtest/devnet end-to-end test if the component test confirms impact.

3. PoC scaffold

\`\`\`rust
// Local-only unit test scaffold. Do not run against testnet or mainnet.
#[test]
fn advice_assignment_must_be_constrained() {
    // Construct honest and malicious witness assignments and assert the malicious
    // assignment is rejected after the fix.
}
\`\`\`

4. Minimal fix

Replace unconstrained advice assignment with copy/equality-constrained assignment.`;
  }

  return "";
}

import assert from "node:assert/strict";
import test from "node:test";
import { extractProofObligations } from "../dist/obligations/extract.js";
import { extractHalo2Provenance, renderProvenanceGraph } from "../dist/provenance/halo2.js";

test("Halo2 provenance extracts advice assignments, copies, and assignment-flow obligations", () => {
  const graph = extractHalo2Provenance([
    {
      path: "chip/mul/incomplete.rs",
      kind: "source",
      content: `
fn assign_incomplete_addition_input(region: &mut Region, row: usize, offset: usize, x_p: Value, y_p: Value) {
    // point scalar multiplication witness advice
    region.assign_advice(|| "x_p", self.double_and_add.x_p, row + offset, || x_p)?;
    region.assign_advice(|| "y_p", self.y_p, row + offset, || y_p)?;
    base_x.copy_advice(|| "base_x", region, self.double_and_add.x_p, row)?;
    meta.create_gate("mul gate", |meta| {
        let q_mul = meta.query_selector(config.q_mul);
        let x = meta.query_advice(config.x, Rotation::cur());
        vec![q_mul * x]
    });
}
`,
    },
  ]);

  assert.equal(graph.domain, "halo2");
  assert.equal(graph.summary.byKind.advice_assignment, 2);
  assert.equal(graph.summary.byKind.advice_copy, 1);
  assert.equal(graph.summary.byKind.gate_creation, 1);
  assert.ok(graph.summary.assignmentFlowObligations >= 2);
  assert.ok(graph.obligations.every((obligation) => obligation.kind === "provenance"));

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /assign_incomplete_addition_input/);
  assert.match(rendered, /source=x_p/);
  assert.match(rendered, /assignment-flow obligations/i);
});

test("proof obligations combine corpus, learning, and provenance facts", () => {
  const graph = extractHalo2Provenance([
    {
      path: "chip/example.rs",
      kind: "source",
      content: 'fn assign(region: &mut Region, row: usize, base: Value) { region.assign_advice(|| "base", self.base, row, || base)?; }',
    },
  ]);
  const obligations = extractProofObligations({
    source: [],
    corpus: [
      {
        path: "book/nullifiers.md",
        kind: "corpus",
        content: "The circuit must check that the diversified public key equals the viewing-key multiplication result.",
      },
    ],
    projectLearning: {
      candidateInvariants: ["Witness values that affect a checked statement should be enforced by visible equations."],
      evidenceRefs: ["book/nullifiers.md:1"],
    },
    provenanceGraphs: [graph],
  });

  assert.ok(obligations.some((obligation) => obligation.kind === "spec"));
  assert.ok(obligations.some((obligation) => obligation.kind === "learning"));
  assert.ok(obligations.some((obligation) => obligation.kind === "provenance"));
  assert.ok(obligations.every((obligation) => obligation.evidenceRefs.every((ref) => !ref.startsWith("/"))));
});

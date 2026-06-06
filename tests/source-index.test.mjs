import assert from "node:assert/strict";
import test from "node:test";
import { SourceIndex } from "../dist/index/source-index.js";
import { retrievalTermsForItem, shouldIncludeStructuralContext } from "../dist/index/retrieval-terms.js";

test("source index expands comma-separated line ranges for one file", () => {
  const doc = makeDoc("external/incomplete.rs", 380, {
    181: "line 181 q_mul_2 selector start",
    254: "line 254 middle accumulator transition",
    309: "line 309 assign_advice x_p",
    310: "line 310 assign_advice y_p",
  });
  const index = new SourceIndex([doc]);
  const context = index.contextForItem(
    {
      id: "multi-range",
      location: "external/incomplete.rs:181-209,254-267,297-362",
      securityProperty: "Assigned advice cells are constrained to the declared ingress values.",
      failureMode: "missing_constraint",
      why: "Model returned a multi-range location.",
    },
    100_000,
  );

  assert.match(context, /line 181 q_mul_2 selector start/);
  assert.match(context, /line 254 middle accumulator transition/);
  assert.match(context, /line 309 assign_advice x_p/);
  assert.match(context, /line 310 assign_advice y_p/);
});

test("source index accepts repeated file names in multi-range locations", () => {
  const doc = makeDoc("src/circuit.rs", 80, {
    12: "line 12 witness input",
    42: "line 42 constraint gate",
  });
  const index = new SourceIndex([doc]);
  const context = index.contextForItem(
    {
      id: "repeated-path",
      location: "src/circuit.rs:12-13, src/circuit.rs:42-44",
      securityProperty: "Witness assignments are bound to constraints.",
      failureMode: "missing_constraint",
      why: "Model returned two explicit ranges.",
    },
    100_000,
  );

  assert.match(context, /line 12 witness input/);
  assert.match(context, /line 42 constraint gate/);
});

test("source index keeps semicolon-separated file ranges on their own files", () => {
  const mul = makeDoc("external/mul.rs", 520, {
    180: "mul line 180 variable-base scalar multiplication",
    488: "mul line 488 unrelated test helper",
  });
  const chip = makeDoc("external/chip.rs", 520, {
    488: "chip line 488 witness_point_non_id boundary",
  });
  const index = new SourceIndex([mul, chip]);
  const context = index.contextForItem(
    {
      id: "multi-file-location",
      location: "external/mul.rs:164-224; external/chip.rs:483-492",
      securityProperty: "The public witness boundary must enforce the base invariant before multiplication.",
      failureMode: "missing_constraint",
      why: "Model returned two explicit file ranges separated by a semicolon.",
    },
    100_000,
  );

  assert.match(context, /mul line 180 variable-base scalar multiplication/);
  assert.match(context, /chip line 488 witness_point_non_id boundary/);
  assert.doesNotMatch(context, /mul line 488 unrelated test helper/);
});

test("source index follows call references from direct context", () => {
  const chip = makeDoc("external/chip.rs", 520, {
    488: "config.point_non_id(value, 0, &mut region)",
  });
  const noisy = makeDoc("external/add.rs", 500, {
    10: "witness boundary filler that should not outrank the referenced helper",
    80: "witness boundary filler that should not outrank the referenced helper",
    160: "witness boundary filler that should not outrank the referenced helper",
  });
  const witness = makeDoc("external/witness_point.rs", 220, {
    167: "pub(super) fn point_non_id(",
    184: "q_point_non_id selector enforces curve membership",
  });
  const index = new SourceIndex([chip, noisy, witness]);
  const context = index.contextForItem(
    {
      id: "follow-call-reference",
      location: "external/chip.rs:483-492",
      securityProperty: "The witness boundary must enforce the non-identity point invariant.",
      failureMode: "input_validation",
      why: "The direct location delegates validation to a helper method.",
    },
    5_000,
  );

  assert.match(context, /config\.point_non_id/);
  assert.match(context, /pub\(super\) fn point_non_id/);
  assert.match(context, /q_point_non_id selector/);
});

test("source index includes call sites for functions referenced by a direct slice", () => {
  const caller = makeDoc("external/mul.rs", 220, {
    105: "let (x_a, y_a, zs) = self.hi_config.double_and_add(",
    106: "    &mut region, offset, base, bits, acc,",
    107: ")?;",
  });
  const callee = makeDoc("external/incomplete.rs", 220, {
    98: "pub(super) fn double_and_add(",
    112: "region.assign_advice(|| \"x_p\", self.x_p, row + offset, || x_p)?;",
    113: "region.assign_advice(|| \"y_p\", self.y_p, row + offset, || y_p)?;",
  });
  const noisy = makeDoc("external/noisy.rs", 220, {
    20: "x_p filler",
    70: "y_p filler",
    120: "constraint filler",
  });
  const index = new SourceIndex([callee, noisy, caller]);
  const trace = index.contextForItemWithTrace(
    {
      id: "callee-input-edge",
      location: "external/incomplete.rs:112-113",
      securityProperty: "Checked cells must stay connected to the incoming base point.",
      failureMode: "missing_constraint",
      why: "The direct location computes cells inside a helper, so the caller edge matters.",
    },
    10_000,
  );

  assert.match(trace.context, /pub\(super\) fn double_and_add/);
  assert.match(trace.context, /self\.hi_config\.double_and_add/);
  assert.ok(trace.slices.some((slice) => slice.path === "external/mul.rs" && slice.reason === "call site double_and_add" && slice.included));
});

test("source index adds constraint setup context for narrow advice-assignment items", () => {
  const doc = makeDoc("external/incomplete.rs", 180, {
    20: "pub(super) fn configure(meta: &mut ConstraintSystem<F>) -> Self {",
    50: "fn create_gate(&self, meta: &mut ConstraintSystem<F>) {",
    112: "line 112 region.assign_advice(|| \"x_p\", self.x_p, row, || x_p)?;",
  });
  const index = new SourceIndex([doc]);
  const context = index.contextForItem(
    {
      id: "base-coordinate-advice-source",
      location: "external/incomplete.rs:112",
      securityProperty: "Assigned advice cells must be bound to the declared ingress values.",
      failureMode: "missing_constraint",
      why: "The item is narrow, but the audit also needs gate and equality setup.",
    },
    100_000,
  );

  assert.match(context, /pub\(super\) fn configure/);
  assert.match(context, /fn create_gate/);
  assert.match(context, /region\.assign_advice/);
});

test("retrieval term helper separates context routing from findings", () => {
  const item = {
    id: "routing-only",
    location: "src/circuit.rs:10",
    securityProperty: "Assigned cells must be checked by the relevant equations.",
    failureMode: "missing_constraint",
    why: "The item needs nearby setup context before an auditor can reason.",
    attackerControlledInputs: ["caller.value"],
  };

  const terms = retrievalTermsForItem(item);
  assert.ok(terms.includes("constraint"));
  assert.ok(terms.includes("caller"));
  assert.equal(shouldIncludeStructuralContext(item, terms), true);
});

function makeDoc(path, lineCount, overrides) {
  const lines = Array.from({ length: lineCount }, (_, idx) => `line ${idx + 1}`);
  for (const [line, text] of Object.entries(overrides)) {
    lines[Number(line) - 1] = text;
  }
  return {
    path,
    content: lines.join("\n"),
    kind: "source",
  };
}

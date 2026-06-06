import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuditItem, selectDiverseAuditItems } from "../dist/items.js";

test("diverse item selection round-robins across source locations before capping", () => {
  const items = [
    item("add-1", "chip/add.rs:10"),
    item("add-2", "chip/add.rs:20"),
    item("add-3", "chip/add.rs:30"),
    item("add-incomplete", "chip/add_incomplete.rs:10"),
    item("mul-complete", "chip/mul/complete.rs:10"),
    item("mul-incomplete", "chip/mul/incomplete.rs:10"),
    item("overflow", "chip/mul/overflow.rs:10"),
  ];

  const selected = selectDiverseAuditItems(items, 4);

  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["add-1", "add-incomplete", "mul-complete", "mul-incomplete"],
  );
});

test("diversity buckets normalize line ranges and multi-range locations", () => {
  const items = [
    item("same-file-range-1", "chip/mul/incomplete.rs:181-209,254-267"),
    item("same-file-range-2", "chip/mul/incomplete.rs:297-362"),
    item("caller", "chip/mul.rs:164-224; chip.rs:483-492"),
  ];

  const selected = selectDiverseAuditItems(items, 2);

  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["same-file-range-1", "caller"],
  );
});

test("normalizer accepts portfolio-style model item schemas", () => {
  const normalized = normalizeAuditItem({
    id: "portfolio-schema",
    title: "Trace assigned value into checks",
    failure_modes: ["missing_constraint", "soundness_gap"],
    source_refs: ["chip/mul/incomplete.rs:309-310"],
    reference_refs: ["book: scalar mul"],
    audit_objective: "Assigned coordinates must be enforced by downstream gates.",
    dataflow: "x_p and y_p are assigned as advice before gate checks consume them.",
    checks: ["Check selector coverage.", "Check equality path."],
  });

  assert.ok(normalized);
  assert.equal(normalized.location, "chip/mul/incomplete.rs:309-310");
  assert.equal(normalized.failureMode, "missing_constraint");
  assert.equal(normalized.securityProperty, "Assigned coordinates must be enforced by downstream gates.");
  assert.match(normalized.why, /x_p and y_p/);
  assert.deepEqual(normalized.specRefs, ["book: scalar mul"]);
});

function item(id, location) {
  return {
    id,
    location,
    securityProperty: `${id} security property`,
    failureMode: "missing_constraint",
    why: `${id} rationale`,
  };
}

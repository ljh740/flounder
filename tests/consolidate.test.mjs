import assert from "node:assert/strict";
import test from "node:test";
import { unionFindClusters } from "../dist/agent/consolidate.js";

// The fix-equivalence relation feeds unionFindClusters; the I/O part (cross-applying a
// fix and re-running a PoC) is the differential primitive, tested separately. Here we
// pin the clustering: symmetry is assumed, transitivity must hold, order is preserved.

const pairEquivalent = (pairs) => {
  const set = new Set(pairs.map(([a, b]) => (a < b ? `${a}::${b}` : `${b}::${a}`)));
  return (a, b) => set.has(a < b ? `${a}::${b}` : `${b}::${a}`);
};

test("unionFindClusters: no equivalences yields one singleton per item", () => {
  const clusters = unionFindClusters(["a", "b", "c"], () => false);
  assert.deepEqual(clusters, [["a"], ["b"], ["c"]]);
});

test("unionFindClusters: a single equivalent pair merges just those two", () => {
  const clusters = unionFindClusters(["a", "b", "c"], pairEquivalent([["a", "b"]]));
  assert.deepEqual(clusters, [["a", "b"], ["c"]]);
});

test("unionFindClusters: equivalence is transitively closed (a~b, b~c => one cluster)", () => {
  const clusters = unionFindClusters(["a", "b", "c"], pairEquivalent([["a", "b"], ["b", "c"]]));
  assert.deepEqual(clusters, [["a", "b", "c"]]);
});

test("unionFindClusters: independent pairs form separate clusters, first-appearance order preserved", () => {
  const clusters = unionFindClusters(["a", "b", "c", "d"], pairEquivalent([["a", "c"], ["b", "d"]]));
  assert.deepEqual(clusters, [["a", "c"], ["b", "d"]]);
});

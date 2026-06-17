import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArgs } from "../dist/server/run-manager.js";
import { MetadataStore } from "../dist/db/store.js";

// buildArgs is the pure core of launching: spec -> fsa CLI argv. The run-manager shells out
// to the same CLI, and continue/restart map to the kernel's resume / --remap behavior.

test("buildArgs: a full run spec maps to the expected verb + flags", () => {
  const args = buildArgs({
    verb: "run",
    target: "acme",
    sourcePaths: ["./contracts", "./src"],
    buildRoot: ".",
    corpusPaths: ["./docs"],
    provider: "openai-codex",
    model: "gpt-5.5",
    thinking: "xhigh",
    maxScopes: 12,
    mapSteps: 60,
    digSteps: 60,
    digSamples: 2,
    out: "runs",
  });
  assert.deepEqual(args, [
    "run",
    "--target", "acme",
    "--source", "./contracts", "./src",
    "--build-root", ".",
    "--corpus", "./docs",
    "--provider", "openai-codex",
    "--model", "gpt-5.5",
    "--thinking", "xhigh",
    "--max-scopes", "12",
    "--map-steps", "60",
    "--dig-steps", "60",
    "--dig-samples", "2",
    "--out", "runs",
  ]);
});

test("buildArgs: restart adds --remap; confirm takes the run dir positionally + --fresh", () => {
  assert.ok(buildArgs({ verb: "run", target: "p", sourcePaths: ["./s"], remap: true }).includes("--remap"));

  const confirm = buildArgs({ verb: "confirm", target: "p", sourcePaths: ["./s"], inputRunDir: "runs/p-123", fresh: true });
  assert.equal(confirm[0], "confirm");
  assert.equal(confirm[1], "runs/p-123"); // positional run dir
  assert.ok(confirm.includes("--fresh"));
  assert.ok(!confirm.includes("--remap")); // --remap is meaningless for confirm

  // audit can pin a region positionally
  const audit = buildArgs({ verb: "audit", target: "p", sourcePaths: ["./s"], region: "src/Foo.sol:10-40" });
  assert.equal(audit[1], "src/Foo.sol:10-40");
});

test("buildArgs: confirm without a run dir is rejected", () => {
  assert.throws(() => buildArgs({ verb: "confirm", target: "p", sourcePaths: ["./s"] }), /inputRunDir/);
});

test("store: a supervisor reconciles a dead process's still-running row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fsa-reconcile-"));
  const db = new MetadataStore(path.join(dir, "fsa.db"));
  const projectId = db.upsertProject({ name: "p" });
  db.startRun({ projectId, kind: "run", runDir: "/runs/p-1", pid: 4242 });

  assert.equal(db.reconcileRunByPid(4242, "killed"), 1); // the running row is marked killed
  assert.equal(db.listRuns(projectId)[0].status, "killed");
  assert.equal(db.reconcileRunByPid(4242, "error"), 0); // already ended → no-op
  db.close();
});

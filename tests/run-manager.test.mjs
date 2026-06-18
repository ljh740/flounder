import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArgs, specToConfig, ActivityBus } from "../dist/server/run-manager.js";
import { MetadataStore } from "../dist/db/store.js";

test("ActivityBus: a subscriber replays backlog then receives live events", () => {
  const bus = new ActivityBus();
  bus.push({ kind: "thinking_delta", delta: "The " });
  bus.push({ kind: "thinking_delta", delta: "decoder" });
  const seen = [];
  const unsub = bus.subscribe((ev) => seen.push(ev.delta ?? ev.tool ?? ev.kind));
  assert.deepEqual(seen, ["The ", "decoder"]); // backlog replayed on subscribe
  bus.push({ kind: "step", tool: "bash" });
  assert.deepEqual(seen, ["The ", "decoder", "bash"]); // live event delivered
  unsub();
  bus.push({ kind: "thinking_delta", delta: "x" });
  assert.equal(seen.length, 3); // no events after unsubscribe
});

// buildArgs is the pure core of launching: spec -> flounder CLI argv. The run-manager shells out
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

// The manager runs the library in-process; specToConfig is the spec -> AuditorConfig
// translation (the in-process equivalent of the CLI's parseConfig + applyAuditPosture).
test("specToConfig: posture per verb + unbounded budgets by default", () => {
  const base = { target: "p", sourcePaths: ["./s"] };

  const run = specToConfig({ ...base, verb: "run" }, "runs");
  assert.equal(run.auditDeep, true); // run = map -> dig
  assert.equal(run.outputDir, "runs");
  assert.equal(Number.isFinite(run.auditMaxSteps), false); // unbounded by default
  assert.equal(Number.isFinite(run.auditMapSteps), false);
  assert.equal(Number.isFinite(run.auditDigSteps), false);

  assert.equal(specToConfig({ ...base, verb: "run", quick: true }, "runs").auditDeep, false); // --quick = breadth

  const map = specToConfig({ ...base, verb: "map" }, "runs");
  assert.equal(map.auditMapOnly, true);

  const region = specToConfig({ ...base, verb: "audit", region: "src/F.sol:10-40" }, "runs");
  assert.equal(region.auditDeepFocus, "src/F.sol:10-40");

  const scoped = specToConfig({ ...base, verb: "audit", scope: "s1, s2" }, "runs");
  assert.equal(scoped.auditRequireInventory, true);
  assert.deepEqual(scoped.auditScopeIds, ["s1", "s2"]);

  // explicit caps + materials + remap are carried
  const capped = specToConfig({ ...base, verb: "run", buildRoot: ".", model: "gpt-5.5", thinking: "xhigh", maxScopes: 8, mapSteps: 50, remap: true }, "out");
  assert.equal(capped.buildRoot, ".");
  assert.equal(capped.auditModel, "gpt-5.5");
  assert.equal(capped.thinkingLevel, "xhigh");
  assert.equal(capped.auditMaxScopes, 8);
  assert.equal(capped.auditMapSteps, 50);
  assert.equal(capped.auditRemap, true);
});

test("specToConfig: a project dir + relative materials resolve under the daemon workspace", () => {
  const cfg = specToConfig(
    { verb: "run", target: "p", dir: "myproj", sourcePaths: ["src", "lib"], buildRoot: ".", corpusPaths: ["docs/specs"] },
    "runs",
    "/ws",
  );
  assert.equal(cfg.sourcePaths[0], path.resolve("/ws/myproj/src"));
  assert.equal(cfg.sourcePaths[1], path.resolve("/ws/myproj/lib"));
  assert.equal(cfg.buildRoot, path.resolve("/ws/myproj")); // "." resolves to the project root
  assert.equal(cfg.corpusPaths[0], path.resolve("/ws/myproj/docs/specs"));
});

test("specToConfig: per-phase models from the profile land on cfg.models; no dir = materials as-is", () => {
  const cfg = specToConfig(
    { verb: "run", target: "p", sourcePaths: ["/abs/x"], models: { map: { thinking: "low" }, dig: { model: "big" } } },
    "runs",
    "/ws",
  );
  assert.equal(cfg.sourcePaths[0], "/abs/x"); // no dir → used verbatim (ad-hoc/legacy)
  assert.equal(cfg.models.map.thinking, "low");
  assert.equal(cfg.models.dig.model, "big");
});

test("store: a supervisor reconciles a dead process's still-running row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-reconcile-"));
  const db = new MetadataStore(path.join(dir, "flounder.db"));
  const projectId = db.upsertProject({ name: "p" });
  db.startRun({ projectId, kind: "run", runDir: "/runs/p-1", pid: 4242 });

  assert.equal(db.reconcileRunByPid(4242, "killed"), 1); // the running row is marked killed
  assert.equal(db.listRuns(projectId)[0].status, "killed");
  assert.equal(db.reconcileRunByPid(4242, "error"), 0); // already ended → no-op
  db.close();
});

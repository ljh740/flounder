import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { loadSource } from "../dist/ingest/source.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { runPipeline } from "../dist/pipeline.js";
import { runSeeders } from "../dist/seeders/index.js";
import { resolveLastRunDir } from "../dist/trace/last-run.js";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");
const basicHalo2Fixture = path.join(fixtures, "halo2_missing_constraint.rs");
const scalarMulFixture = path.join(fixtures, "halo2_scalar_mul_binding.rs");

test("checklist seeders enumerate Halo2 missing-constraint audit items", async () => {
  const source = await loadSource([basicHalo2Fixture]);
  const items = runSeeders(source);
  assert.ok(source.every((doc) => !path.isAbsolute(doc.path)));
  assert.ok(source.every((doc) => !doc.path.includes(root)));
  assert.equal(items.filter((item) => item.failureMode === "missing_constraint").length, 2);
  assert.ok(items.every((item) => item.location.includes("halo2_missing_constraint.rs")));
});

test("checklist seeders enumerate scalar-mul advice binding questions from source shape", async () => {
  const source = await loadSource([scalarMulFixture]);
  const items = runSeeders(source);
  const bindingItems = items.filter((item) => item.seeder === "halo2_advice_binding");
  assert.equal(bindingItems.length, 1);
  assert.equal(bindingItems[0].failureMode, "missing_constraint");
  assert.match(bindingItems[0].location, /halo2_scalar_mul_binding\.rs:13-14/);
  assert.match(bindingItems[0].why, /scalar\/point-binding context/);
  assert.match(bindingItems[0].securityProperty, /constrained to that input/);
});

test("dry-run pipeline writes checklist and summary without model calls", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-dry-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-dry";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.dryRun = true;
  cfg.localChecklistSeeders = true;

  const result = await runPipeline(cfg);
  assert.equal(result.summary.coverage.itemsTotal, 5);
  assert.equal(result.summary.coverage.itemsWithFinding, 0);
  assert.equal(result.summary.coverage.bySeverity.high, 0);
  assert.deepEqual(result.summary.findings, []);
  await stat(path.join(result.runDir, "checklist.json"));
  await stat(path.join(result.runDir, "audit_results.json"));
  await stat(path.join(result.runDir, "lens_packs.json"));
  await stat(path.join(result.runDir, "summary.json"));
  await stat(path.join(result.runDir, "source_index.json"));
  await stat(path.join(result.runDir, "checklist_coverage.json"));
  assert.deepEqual(await readdir(path.join(result.runDir, "calls")), []);
});

test("mock pipeline runs enumerate, audit, verify, and report end to end", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-mock-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-mock";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;
  cfg.localChecklistSeeders = true;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 2 });
  assert.equal(result.summary.coverage.itemsTotal, 6);
  assert.equal(result.summary.coverage.itemsWithFinding, 6);
  assert.equal(result.summary.coverage.bySeverity.high, 6);

  const verification = JSON.parse(await readFile(path.join(result.runDir, "verifications.json"), "utf8"));
  assert.equal(verification.length, 2);
  const lensPacks = JSON.parse(await readFile(path.join(result.runDir, "lens_packs.json"), "utf8"));
  assert.equal(lensPacks[0].id, "mock-project-lens");
  const learning = JSON.parse(await readFile(path.join(result.runDir, "project_learning.json"), "utf8"));
  assert.match(learning.scopeSummary, /Mock initialization notes/);

  const coverage = JSON.parse(await readFile(path.join(result.runDir, "run_coverage.json"), "utf8"));
  assert.equal(coverage.checklist.byFailureMode.missing_constraint, 6);
  assert.equal(Object.keys(coverage.checklist.bySourceFile).length, 2);
  assert.deepEqual(Object.keys(coverage.checklist.bySourceFile).sort(), [
    "fixtures/halo2_missing_constraint.rs",
    "fixtures/halo2_scalar_mul_binding.rs",
  ]);
  const contextTrace = JSON.parse(await readFile(path.join(result.runDir, "round_1_context_retrieval.json"), "utf8"));
  assert.equal(contextTrace.length, 6);
  assert.ok(contextTrace.every((trace) => trace.mode === "source-index"));
  assert.ok(contextTrace.every((trace) => trace.slices.every((slice) => !path.isAbsolute(slice.path))));

  const firstFindingId = result.summary.findings[0].id;
  const reportName = `report_${firstFindingId}.md`;
  const report = await readFile(path.join(result.runDir, reportName), "utf8");
  assert.match(report, /Security disclosure/);
  assert.match(report, /local, isolated environment only/i);

  for (const artifact of [
    "source_index.json",
    "project_learning.json",
    "checklist.json",
    "checklist_coverage.json",
    "run_coverage.json",
    "events.jsonl",
    reportName,
  ]) {
    const body = await readFile(path.join(result.runDir, artifact), "utf8");
    assertNoLocalAbsolutePath(body, artifact, [root, out]);
  }
});

test("model-only mode requires checklist items from model enumeration", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-model-only-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-model-only";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;
  assert.equal(cfg.localChecklistSeeders, false);

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 1);
  assert.equal(result.summary.coverage.itemsWithFinding, 1);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.equal(checklist.length, 1);
  assert.equal("seeder" in checklist[0], false);
  assert.equal(checklist[0].why, "Mock enumeration item used to test end-to-end model-driven audit flow.");

  const calls = await readdir(path.join(result.runDir, "calls"));
  assert.ok(calls.some((file) => /_learn_project\.json$/.test(file)));
  assert.ok(calls.some((file) => /_discover_lenses\.json$/.test(file)));
  assert.ok(calls.some((file) => /_enumerate\.json$/.test(file)));
  assert.ok(calls.some((file) => /_audit_/.test(file)));
});

test("multi-round mode deepens with novel follow-up checklist items", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-rounds-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-rounds";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 3);
  assert.equal(result.summary.coverage.itemsWithFinding, 3);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2, 2]);
  assert.deepEqual(checklist.slice(1).map((item) => item.strategy).sort(), ["breadth", "depth"]);
  assert.equal(new Set(checklist.map((item) => `${item.location}|${item.failureMode}|${item.securityProperty}`)).size, 3);

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.strategy, "hybrid");
  assert.equal(deepening.accepted.length, 2);
  assert.deepEqual(deepening.branches.map((branch) => branch.strategy), ["breadth", "depth"]);
  assert.ok(deepening.accepted.some((item) => item.id === "mock-round-2-enforcement-edge"));
  assert.ok(deepening.accepted.some((item) => item.id === "mock-round-2-proof-obligation"));

  const calls = await readdir(path.join(result.runDir, "calls"));
  assert.ok(calls.some((file) => /_deepen_round_2_breadth\.json$/.test(file)));
  assert.ok(calls.some((file) => /_deepen_round_2_depth\.json$/.test(file)));
  await stat(path.join(result.runDir, "round_1_audit_results.json"));
  await stat(path.join(result.runDir, "round_2_audit_results.json"));
});

test("multi-round item cap reserves budget for follow-up exploration", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-budgeted-rounds-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-budgeted-rounds";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.maxAuditItems = 3;
  cfg.maxNewItemsPerRound = 1;
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new BudgetedRoundsLlmClient(), verifyTopK: 0 });
  assert.equal(result.summary.coverage.itemsTotal, 3);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 1, 2]);
  assert.equal(checklist.at(-1).id, "budget-round-2-follow-up");

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.accepted.length, 1);

  const events = await readFile(path.join(result.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"deepening_done"/);
  assert.doesNotMatch(events, /max_audit_items_reached/);
});

test("breadth strategy uses only breadth deepening budget", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-breadth-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-breadth";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.explorationStrategy = "breadth";
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 2);

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.strategy, "breadth");
  assert.deepEqual(deepening.branches.map((branch) => branch.strategy), ["breadth"]);
  assert.equal(deepening.accepted[0].strategy, "breadth");
});

test("resume mode appends additional rounds to the previous run", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-resume-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 1;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  const pointer = JSON.parse(await readFile(path.join(out, ".fsa-last-run.json"), "utf8"));
  assert.equal(pointer.runDirName, path.basename(first.runDir));
  assert.equal(path.isAbsolute(pointer.runDirName), false);
  assert.equal(pointer.runDirName.includes(path.sep), false);
  assert.equal(await resolveLastRunDir(out), first.runDir);

  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: await resolveLastRunDir(out),
  });
  assert.equal(resumed.runDir, first.runDir);
  assert.equal(resumed.summary.coverage.itemsTotal, 3);

  const checklist = JSON.parse(await readFile(path.join(first.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2, 2]);

  const resumeState = JSON.parse(await readFile(path.join(first.runDir, "resume_state.json"), "utf8"));
  assert.equal(resumeState.completedRounds, 1);
  assert.equal(resumeState.additionalRounds, 1);
  assert.equal(resumeState.nextRound, 2);

  const events = await readFile(path.join(first.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"resume_loaded"/);
  await stat(path.join(first.runDir, "round_1_audit_results.json"));
  await stat(path.join(first.runDir, "round_2_audit_results.json"));
});

test("resume mode recovers from partial round artifacts", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-partial-resume-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-partial-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 1;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  await rm(path.join(first.runDir, "audit_results.json"));
  await writeFile(
    path.join(first.runDir, "round_2_deepening_items.json"),
    JSON.stringify(
      {
        round: 2,
        strategy: "depth",
        accepted: [
          {
            id: "pending-round-2",
            location: "fixtures/halo2_scalar_mul_binding.rs:13-14",
            securityProperty: "A pending item generated before interruption must be audited on resume.",
            failureMode: "missing_constraint",
            why: "This pending item simulates a failed run after deepening but before round audit completion.",
            round: 2,
            strategy: "depth",
          },
        ],
      },
      null,
      2,
    ),
  );

  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: first.runDir,
  });

  assert.equal(resumed.runDir, first.runDir);
  assert.equal(resumed.summary.coverage.itemsTotal, 2);
  const checklist = JSON.parse(await readFile(path.join(first.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2]);
  const resumeState = JSON.parse(await readFile(path.join(first.runDir, "resume_state.json"), "utf8"));
  assert.equal(resumeState.completedRounds, 1);
  assert.equal(resumeState.pendingRoundItems, 1);
  const events = await readFile(path.join(first.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"pending_round_loaded"/);
  await stat(path.join(first.runDir, "round_2_audit_results.json"));
});

test("resume mode retries model-error items from the same round", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-model-error-resume-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-model-error-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  const resultsPath = path.join(first.runDir, "audit_results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  const failed = results.find((result) => result.item.round === 2);
  assert.ok(failed);
  failed.nHits = 0;
  failed.hitRate = 0;
  failed.trials = [
    {
      finding: false,
      title: "Model call failed",
      severity: "info",
      confidence: 0,
      description: "Synthetic model error.",
      evidence: "",
      exploitSketch: "",
      fix: "",
      modelError: true,
      raw: "limit reached",
    },
  ];
  await writeFile(resultsPath, JSON.stringify(results, null, 2));

  cfg.rounds = 1;
  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: first.runDir,
  });

  assert.equal(resumed.summary.coverage.itemsTotal, 3);
  assert.equal(resumed.summary.coverage.itemsWithFinding, 3);
  const retryResults = JSON.parse(await readFile(path.join(first.runDir, "round_2_audit_results.json"), "utf8"));
  assert.equal(retryResults.length, 1);
  assert.equal(retryResults[0].item.id, failed.item.id);
  assert.equal(retryResults[0].trials[0].modelError, undefined);
  const resumeState = JSON.parse(await readFile(path.join(first.runDir, "resume_state.json"), "utf8"));
  assert.equal(resumeState.completedRounds, 1);
  assert.equal(resumeState.pendingRoundItems, 1);
});

class BudgetedRoundsLlmClient {
  async complete(input) {
    if (input.tag === "learn_project") {
      return JSON.stringify({
        scopeSummary: "Budgeted round regression target.",
        securityObjectives: ["Model-produced checklist items must leave room for follow-up exploration."],
        domainConcepts: ["checked assignment"],
        trustBoundaries: ["private witness values"],
        attackerCapabilities: ["choose private inputs"],
        candidateInvariants: ["checked logic must bind values to their intended source"],
        implementationMechanics: ["fixtures contain small circuit-like code"],
        uncertainty: [],
        evidenceRefs: ["fixtures"],
      });
    }
    if (input.tag === "discover_lenses") {
      return JSON.stringify([]);
    }
    if (input.tag === "enumerate") {
      return JSON.stringify([
        budgetItem("budget-add-1", "fixtures/halo2_missing_constraint.rs:5"),
        budgetItem("budget-add-2", "fixtures/halo2_missing_constraint.rs:6"),
        budgetItem("budget-mul-1", "fixtures/halo2_scalar_mul_binding.rs:13"),
        budgetItem("budget-mul-2", "fixtures/halo2_scalar_mul_binding.rs:14"),
      ]);
    }
    if (input.tag === "deepen_round_2_breadth") {
      return JSON.stringify([budgetItem("budget-round-2-follow-up", "fixtures/halo2_scalar_mul_binding.rs:13-14")]);
    }
    if (input.tag.startsWith("audit_")) {
      return JSON.stringify({
        finding: false,
        title: "No finding",
        severity: "info",
        confidence: 0.5,
        description: "Budget regression test response.",
        evidence: "No security claim is made by this fixture client.",
        exploitSketch: "",
        fix: "",
      });
    }
    return "";
  }
}

function budgetItem(id, location) {
  return {
    id,
    location,
    securityProperty: `${id} security property`,
    failureMode: "missing_constraint",
    why: `${id} rationale`,
  };
}

function assertNoLocalAbsolutePath(body, label, forbiddenRoots) {
  for (const forbiddenRoot of forbiddenRoots) {
    assert.equal(body.includes(forbiddenRoot), false, `${label} includes a local absolute path`);
  }
}

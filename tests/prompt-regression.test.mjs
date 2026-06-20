import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultConfig } from "../dist/config.js";
import {
  AUDIT_DEEP_SYSTEM,
  AUDIT_SYNTHESIS_SYSTEM,
  AUDIT_SYSTEM,
  AUDIT_VERIFY_SYSTEM,
  MAP_SYSTEM,
  POC_TRUST_RULE,
} from "../dist/agent/prompts.js";
import { buildSessionPrompt } from "../dist/agent/pi-session.js";

const root = path.resolve(".");
const registryPath = path.join(root, "fixtures/prompt-regression/known-bugs.json");
const execFileAsync = promisify(execFile);

async function loadRegistry() {
  return JSON.parse(await readFile(registryPath, "utf8"));
}

function defaultPromptCorpus() {
  const cfg = defaultConfig();
  return [
    AUDIT_SYSTEM,
    AUDIT_DEEP_SYSTEM,
    MAP_SYSTEM,
    AUDIT_VERIFY_SYSTEM,
    AUDIT_SYNTHESIS_SYSTEM,
    POC_TRUST_RULE,
    buildSessionPrompt({ cfg, fileManifest: "example.rs" }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", deep: true }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", map: true }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", verify: "suspected finding" }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", synthesize: "prior per-scope findings" }),
  ].join("\n");
}

test("known-bug prompt regression registry has replay fixtures for all local evidence cases", async () => {
  const registry = await loadRegistry();
  assert.equal(registry.version, 1);
  assert.deepEqual(
    registry.cases.map((entry) => entry.id),
    [
      "zcash-orchard-halo2-missing-constraint",
      "aztec-2026-06-14-unbound-settlement-count",
      "aztec-2026-06-17-recursive-verifier-boundary",
    ],
  );

  for (const entry of registry.cases) {
    assert.ok(entry.localEvidenceSummary.length > 40, `${entry.id} needs a local evidence summary`);
    assert.ok(entry.expectedLiveEvalSignals.length >= 4, `${entry.id} needs live-eval signals`);
    assert.ok(entry.artifactSignalGroups.length >= 3, `${entry.id} needs scoreable artifact signal groups`);
    assert.ok(entry.doNotInjectIntoPrompt.length >= 3, `${entry.id} needs answer-leak sentinels`);
    for (const fixture of entry.requiredFixtures) {
      await access(path.join(root, fixture));
      const content = await readFile(path.join(root, fixture), "utf8");
      assert.ok(content.length > 100, `${fixture} should be a meaningful replay fixture`);
    }
  }
});

test("default prompts retain the generic capabilities needed by known-bug regressions", async () => {
  const registry = await loadRegistry();
  const corpus = defaultPromptCorpus();

  for (const expectation of registry.promptContract.requiredNeedles) {
    assert.ok(
      corpus.includes(expectation.needle),
      `prompt corpus missing generic capability: ${expectation.capability} (${expectation.needle})`,
    );
  }
});

test("default prompts do not hard-code known-bug answers or local target identifiers", async () => {
  const registry = await loadRegistry();
  const corpus = defaultPromptCorpus();
  const forbidden = new Set(registry.promptContract.forbiddenDefaultPromptNeedles);
  for (const entry of registry.cases) {
    for (const needle of entry.doNotInjectIntoPrompt) forbidden.add(needle);
  }

  for (const needle of forbidden) {
    assert.equal(corpus.includes(needle), false, `default prompt leaked known-bug answer term: ${needle}`);
  }
});

test("prompt regression eval runner expands dry-run plans without model calls", async () => {
  const { stdout } = await execFileAsync(
    "node",
    [
      "scripts/prompt-regression-eval.mjs",
      "--dry-run",
      "--case",
      "aztec-2026-06-17-recursive-verifier-boundary",
      "--samples",
      "2",
      "--variant",
      "candidate",
    ],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.variant, "candidate");
  assert.equal(plan.runs.length, 2);
  assert.deepEqual(
    plan.runs.map((run) => run.caseId),
    ["aztec-2026-06-17-recursive-verifier-boundary", "aztec-2026-06-17-recursive-verifier-boundary"],
  );
  assert.ok(plan.runs.every((run) => run.mode === "deep"));
  assert.ok(plan.runs.every((run) => run.sourcePaths.length === 1));
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { ProjectMemory } from "../dist/agent/memory.js";
import { buildTools, ingestFindingsFromScratch, newSession } from "../dist/agent/tools.js";
import { runHunt } from "../dist/agent/hunt.js";
import { runHuntLoop, isTransientError } from "../dist/agent/loop.js";
import { runDifferentialConfirmation } from "../dist/agent/differential.js";
import { runRefutation } from "../dist/agent/refutation.js";
import { isPiSessionProvider, mapThinkingLevel } from "../dist/agent/pi-session.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { RunLogger } from "../dist/trace/logger.js";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "fsa-agent-"));
}

async function tempLogger(baseDir) {
  const logger = new RunLogger(baseDir, "agent-test", new Date(), { streamEvents: false });
  await logger.init();
  return logger;
}

function tool(name) {
  return buildTools().find((entry) => entry.name === name);
}

test("driver routing: real pi providers use the continuous session, mock/CLI fallbacks use the loop", () => {
  assert.equal(isPiSessionProvider("openai-codex"), true);
  assert.equal(isPiSessionProvider("claude-code"), false);
  assert.equal(isPiSessionProvider("codex-cli"), false);
  assert.equal(isPiSessionProvider("mock"), false);
  assert.equal(isPiSessionProvider("not-a-real-provider"), false);
});

test("pi session preserves the configured xhigh thinking level", () => {
  assert.equal(defaultConfig().thinkingLevel, "xhigh");
  assert.equal(mapThinkingLevel("minimal"), "minimal");
  assert.equal(mapThinkingLevel("xhigh"), "xhigh");
});

test("project memory persists notes and recalls by keyword overlap", async () => {
  const dir = await tempDir();
  try {
    const memory = new ProjectMemory(path.join(dir, "memory.jsonl"));
    await memory.remember({ note: "nullifier reuse possible in spend.rs:42", kind: "finding", tags: ["nullifier"] });
    await memory.remember({ note: "oracle freshness check is enforced; not a bug", kind: "dead-end" });

    const hits = await memory.recall("nullifier reuse", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "finding");

    const all = await memory.all();
    assert.equal(all.length, 2);

    // No lexical overlap -> no scored recall.
    assert.equal((await memory.recall("totally unrelated xyzzy")).length, 0);

    // A fresh memory file is empty, not an error.
    assert.deepEqual(await new ProjectMemory(path.join(dir, "missing.jsonl")).all(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findings.json only reaches confirmed-executable when it cites a passing bash command", () => {
  const session = newSession();
  session.commandRuns.push({ id: "cmd1", passed: true, command: "node --test x", matched: ["ok"], missing: [], exitCode: 0, expectedExitCode: 0, timedOut: false, workspace: "w" });
  session.commandRuns.push({ id: "cmd2", passed: false, command: "node --test y", matched: [], missing: ["ok"], exitCode: 1, expectedExitCode: 0, timedOut: false, workspace: "w" });
  session.scratchFiles.set(
    "findings.json",
    JSON.stringify([
      { title: "A", location: "a.rs:1" },
      { title: "B", location: "a.rs:2", command_id: "cmd9" },
      { title: "C", location: "a.rs:3", command_id: "cmd1" },
      { title: "D", location: "a.rs:4", command_id: "cmd2" },
    ]),
  );

  const result = ingestFindingsFromScratch(session);
  assert.equal(result.parsed, 4);
  assert.match(result.errors.join("\n"), /cmd9/);
  assert.match(result.errors.join("\n"), /cmd2/);
  assert.equal(session.findings[0].confirmationStatus, "suspected");
  assert.equal(session.findings[1].confirmationStatus, "suspected");
  assert.equal(session.findings[2].confirmationStatus, "confirmed-executable");
  assert.equal(session.findings[3].confirmationStatus, "suspected");
});

test("bash refuses non-local or non-inspection commands without touching the workspace", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };
    const bash = tool("bash");

    const destructive = await bash.run({ cmd: "rm -rf ." }, ctx);
    assert.match(destructive.observation, /blocked/i);

    const liveNetwork = await bash.run({ cmd: "forge test --fork-url https://mainnet.example/rpc", success_patterns: ["x"] }, ctx);
    assert.match(liveNetwork.observation, /blocked/i);

    assert.equal(ctx.session.commandRuns.length, 0, "blocked commands must not record a command run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read, write, edit, and bash operate on loaded material and the copied workspace", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const source = [{ path: "circuit.rs", kind: "source", content: "fn assign() {\n  region.assign_advice(x);\n}\n" }];
    const ctx = { cfg, source, corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const read = await tool("read").run({ path: "circuit.rs", start: 1, end: 2 }, ctx);
    assert.match(read.observation, /assign_advice/);
    assert.match(read.observation, /circuit\.rs lines 1-2 of 4/);

    await tool("write").run({ path: "scratch.txt", content: "hello old value\n" }, ctx);
    const edited = await tool("edit").run({ path: "scratch.txt", old: "old", new: "new" }, ctx);
    assert.match(edited.observation, /edited scratch\.txt/);
    const scratch = await tool("read").run({ path: "scratch.txt" }, ctx);
    assert.match(scratch.observation, /hello new value/);

    await tool("write").run({
      path: "hunt_repro.test.mjs",
      content: "import test from 'node:test';\n\ntest('local harness success', () => {});\n",
    }, ctx);
    const run = await tool("bash").run({ cmd: "node --test hunt_repro.test.mjs", purpose: "confirm", success_patterns: ["local harness success"] }, ctx);
    assert.match(run.observation, /CONFIRMATION-ELIGIBLE PASS/);
    assert.equal(ctx.session.commandRuns.length, 1);
    assert.equal(ctx.session.commandRuns[0].passed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an inspection command cannot forge confirmation by printing a success pattern", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    // The model writes a file that contains the success pattern, then tries to
    // "confirm" by cat-ing it. cat is not a test command, so it must not pass.
    await tool("write").run({ path: "fake_evidence.txt", content: "INVARIANT BROKEN\n" }, ctx);
    const forged = await tool("bash").run({ cmd: "cat fake_evidence.txt", purpose: "confirm", success_patterns: ["INVARIANT BROKEN"] }, ctx);
    assert.match(forged.observation, /not confirmation-eligible/i);
    assert.match(forged.observation, /test\/build runner/i);
    assert.equal(ctx.session.commandRuns.at(-1).passed, false, "inspection commands must never mint confirmation");

    // The same inspection command as purpose=inspect is fine and just shows output.
    const inspect = await tool("bash").run({ cmd: "cat fake_evidence.txt" }, ctx);
    assert.match(inspect.observation, /\(inspect\)/);
    assert.ok(!/not confirmation-eligible/i.test(inspect.observation), "inspect runs must not show a confirmation verdict");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline integrity: the model cannot modify the target source under audit", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const session = newSession();
    session.baselineFiles = new Set(["halo2_missing_constraint.rs", "halo2_scalar_mul_binding.rs"]);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session };

    // Writing over a target-source file is blocked — the model can't tamper with what it audits.
    const overwrite = await tool("write").run({ path: "halo2_missing_constraint.rs", content: "fn neutralized() {}\n" }, ctx);
    assert.match(overwrite.observation, /blocked/i);
    assert.match(overwrite.observation, /target source/i);

    // A new test file is fine.
    const newFile = await tool("write").run({ path: "exploit_test.rs", content: "// poc\n" }, ctx);
    assert.match(newFile.observation, /wrote exploit_test\.rs/);

    // Editing a target-source file is blocked too (even before the old-text check).
    const edit = await tool("edit").run({ path: "halo2_missing_constraint.rs", old: "assign_advice", new: "x" }, ctx);
    assert.match(edit.observation, /blocked/i);
    assert.equal(session.baselineFiles.has("exploit_test.rs"), false, "new files are not part of the protected baseline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transient-throttle classification: server rate limits retry, real quota exhaustion does not", () => {
  // The exact message from a provider-side throttle — must be treated as transient.
  assert.equal(isTransientError("claude exited: API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"), true);
  assert.equal(isTransientError("HTTP 429 Too Many Requests"), true);
  assert.equal(isTransientError("Service overloaded, please retry"), true);
  assert.equal(isTransientError("socket hang up"), true);
  // A genuine daily usage-limit exhaustion is NOT transient — retrying is futile.
  assert.equal(isTransientError("You have hit your usage limit for today"), false);
  assert.equal(isTransientError("monthly quota exceeded"), false);
  assert.equal(isTransientError("invalid JSON in tool action"), false);
});

test("independent refutation: a skeptic verdict is attached to each confirmed finding", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    const source = [{ path: "x.rs", kind: "source", content: "fn check() { /* ... */ }\n" }];
    const findings = [
      { id: "f1", title: "real", severity: "high", location: "x.rs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable" },
      { id: "f2", title: "bogus", severity: "high", location: "x.rs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable" },
    ];
    // Skeptic refutes f2 (says it's actually safe) but cannot refute f1.
    const llm = {
      async complete(input) {
        if (input.tag === "refute_f2") return JSON.stringify({ refuted: true, reason: "the property IS enforced at line 1" });
        return JSON.stringify({ refuted: false, reason: "could not refute" });
      },
    };
    const verdicts = await runRefutation({ findings, source, cfg, llm, logger, max: 8 });
    assert.equal(verdicts.length, 2);
    assert.equal(findings[0].refutation.refuted, false);
    assert.equal(findings[1].refutation.refuted, true);
    assert.match(findings[1].refutation.reason, /enforced/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forced finalize: a run that never writes findings.json still captures hypotheses", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.huntMaxSteps = 3;
    const logger = await tempLogger(dir);
    const session = newSession();
    const ctx = {
      cfg,
      source: [{ path: "x.rs", kind: "source", content: "line1\nline2\nline3\n" }],
      corpus: [],
      memory: new ProjectMemory(path.join(dir, "memory.jsonl")),
      logger,
      session,
    };
    // A model that investigates forever (always reads) and never writes findings.json,
    // then on the dedicated finalize call returns its residual hypotheses.
    const llm = {
      async complete(input) {
        if (input.tag === "hunt_finalize") {
          return JSON.stringify([
            { title: "Residual suspicion in x.rs", severity: "medium", location: "x.rs:2", description: "looked off", confidence: 0.3 },
          ]);
        }
        return JSON.stringify({ thought: "one more read", tool: "read", args: { path: "x.rs" } });
      },
    };

    const result = await runHuntLoop({ cfg, llm, tools: buildTools(), ctx, logger, maxSteps: 3, fileManifest: "x.rs" });
    assert.equal(result.stoppedReason, "step-budget");
    // The forced finalize wrote findings.json even though the model never did.
    assert.ok(session.scratchFiles.has("findings.json"), "finalize must capture output when the model never writes it");
    const ingest = ingestFindingsFromScratch(session);
    assert.equal(ingest.parsed, 1);
    assert.equal(session.findings[0].confirmationStatus, "suspected");
    assert.match(session.findings[0].title, /Residual suspicion/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("differential confirmation: a real fix blocks the exploit; a no-op fix does not confirm", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    // Target source with the bug (accepts everything), plus the model's exploit test.
    await writeFile(path.join(dir, "vuln.mjs"), "export function check(x) { return true; }\n");
    await writeFile(
      path.join(dir, "exploit.test.mjs"),
      'import { check } from "./vuln.mjs";\nif (check("bad-input")) console.log("EXPLOIT OK"); else console.log("EXPLOIT BLOCKED");\n',
    );
    const workspace = { absolute: dir, relative: "w" };
    const baselineFiles = new Set(["vuln.mjs"]);
    const exploitRun = {
      id: "cmd1",
      passed: true,
      command: "node exploit.test.mjs",
      commandSpec: { program: "node", args: ["exploit.test.mjs"], expectedExitCode: 0, timeoutMs: 30000 },
      successPatterns: ["EXPLOIT OK"],
      matched: ["EXPLOIT OK"],
      missing: [],
      exitCode: 0,
      expectedExitCode: 0,
      timedOut: false,
      workspace: "w",
    };
    const baseFinding = { id: "f1", title: "x", severity: "high", location: "vuln.mjs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable", commandRunId: "cmd1" };

    // A real fix: the exploit is blocked after it -> confirmed-differential.
    const realFix = {
      ...baseFinding,
      fixPatch: { path: "vuln.mjs", old: "return true;", new: 'return x === "good";' },
      patchedSuccessPatterns: ["EXPLOIT BLOCKED"],
    };
    const real = await runDifferentialConfirmation({ workspace, finding: realFix, exploitRun, baselineFiles, cfg, logger });
    assert.equal(real.confirmed, true, real.reason);
    assert.equal(real.exploitStillReproduces, false);
    // Source restored to baseline after the differential.
    assert.equal(await readFile(path.join(dir, "vuln.mjs"), "utf8"), "export function check(x) { return true; }\n");

    // A no-op fix (changes nothing relevant): exploit still reproduces -> not confirmed.
    const noopFix = {
      ...baseFinding,
      fixPatch: { path: "vuln.mjs", old: "export function check", new: "export function check /* noop */" },
      patchedSuccessPatterns: ["EXPLOIT BLOCKED"],
    };
    const noop = await runDifferentialConfirmation({ workspace, finding: noopFix, exploitRun, baselineFiles, cfg, logger });
    assert.equal(noop.confirmed, false);
    assert.equal(noop.exploitStillReproduces, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hunt produces an execution-confirmed finding and banks cross-run memory", async () => {
  const dir = await tempDir();
  try {
    const corpusFile = path.join(dir, "spec.md");
    await writeFile(corpusFile, "# Protocol spec\nThe nullifier must be unique per note.\n");
    const cfg = defaultConfig();
    cfg.targetName = "agent-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [corpusFile];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntMaxSteps = 10;

    const { runDir, summary } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    assert.equal(summary.findings.length, 1);
    const finding = summary.findings[0];
    assert.equal(finding.confirmationStatus, "confirmed-executable", "a finding the skeptic could not refute stays confirmed");
    assert.equal(finding.failureMode, "autonomous", "hunt findings are not forced into a fixed taxonomy");
    assert.equal(summary.coverage.verifiedFindings, 1);
    assert.equal(summary.coverage.unverifiedFindings, 0);
    assert.equal(summary.coverage.hypotheses, 0, "the mock's single candidate is confirmed, so there are no hypotheses");

    // Only confirmed candidates become findings; hypotheses are a separate artifact.
    const findingsArtifact = JSON.parse(await readFile(path.join(runDir, "hunt_findings.json"), "utf8"));
    assert.equal(findingsArtifact.length, 1);
    const hypothesesArtifact = JSON.parse(await readFile(path.join(runDir, "hunt_hypotheses.json"), "utf8"));
    assert.equal(hypothesesArtifact.length, 0);

    // The fixture workspace has no toolchain manifest, so the warm-up is a no-op
    // (no hunt_prepare.json) and never blocks an offline run.
    let prepareWritten = true;
    try {
      await stat(path.join(runDir, "hunt_prepare.json"));
    } catch {
      prepareWritten = false;
    }
    assert.equal(prepareWritten, false, "warm-up must no-op when no manifest is present");

    // Corpus is copied into the workspace so the agent can read/grep it.
    const corpusEntries = await readdir(path.join(runDir, "hunt", "workspace", "corpus"));
    assert.ok(corpusEntries.length >= 1, "corpus material must be copied into the workspace");

    const transcript = JSON.parse(await readFile(path.join(runDir, "hunt_transcript.json"), "utf8"));
    assert.equal(transcript.stoppedReason, "finished");
    assert.ok(transcript.steps.some((step) => step.tool === "read"));
    assert.ok(transcript.steps.some((step) => step.tool === "write"));
    assert.ok(transcript.steps.some((step) => step.tool === "bash"));
    assert.ok(!transcript.steps.some((step) => step.tool === "dataflow"), "hunt default tools must not include strategy aids");

    const commandRuns = JSON.parse(await readFile(path.join(runDir, "hunt_command_runs.json"), "utf8"));
    assert.equal(commandRuns.length, 1);
    assert.equal(commandRuns[0].passed, true);

    // Run artifacts must stay free of machine-absolute source paths.
    const report = await readFile(path.join(runDir, "report_f1.md"), "utf8");
    assert.ok(!report.includes(root), "reports must not leak local absolute paths");

    // Memory persisted under project history for the next run.
    const memoryPath = path.join(cfg.outputDir, "history", "agent-e2e", "memory.jsonl");
    assert.ok((await stat(memoryPath)).isFile());
    const notes = (await readFile(memoryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(notes.some((note) => note.kind === "finding"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { ProjectMemory } from "../dist/agent/memory.js";
import { buildTools, ingestFindingsFromScratch, newSession } from "../dist/agent/tools.js";
import { runHunt } from "../dist/agent/hunt.js";
import { isPiSessionProvider } from "../dist/agent/pi-session.js";
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

test("hunt produces an execution-confirmed finding and banks cross-run memory", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "agent-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntMaxSteps = 10;

    const { runDir, summary } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    assert.equal(summary.findings.length, 1);
    const finding = summary.findings[0];
    assert.equal(finding.confirmationStatus, "confirmed-executable");
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

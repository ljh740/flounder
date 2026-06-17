#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultConfig, normalizeProjectContext, normalizeRoleModels, type AuditorConfig } from "./config.js";
import { runAudit } from "./agent/audit.js";
import { runConfirm } from "./agent/confirm.js";
import { MockAuditLlmClient } from "./llm/mock.js";
import { importRunToProjectHistory, projectHistoryManifestPath } from "./trace/history.js";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "history") {
    await runHistoryCommand(rest);
    return;
  }

  if (cmd === "run") {
    const { cfg } = await parseConfig(rest);
    if (cfg.sourcePaths.length === 0) throw new Error("--source <paths...> is required");
    if (cfg.dryRun) throw new Error("fsa run is an agentic mode and cannot run in --dry-run; use the mock model with --mock-llm for offline checks");
    const result = await runAudit(cfg, {
      streamEvents: true,
      ...(hasFlag(rest, "--mock-llm") ? { llm: new MockAuditLlmClient() } : {}),
    });
    printCoverage(result.runDir, result.summary.coverage);
    console.log(`[report] ${result.runDir}/audit_report.md  ← consolidated results (findings, hypotheses, scope coverage)`);
    if (result.scopeCoverage) {
      const { total, audited, pending } = result.scopeCoverage;
      console.log(`[scopes] audited ${audited}/${total}` + (pending > 0 ? `, ${pending} pending — run the same command again to audit the next batch (or --remap to re-enumerate).` : " — inventory fully audited."));
    }
    return;
  }

  if (cmd === "confirm") {
    // Open-world confirmation pass over a prior `fsa run`: freeze its findings, then
    // reproduce/consolidate them against real-world ground truth (network enabled) and
    // emit a submit/no-submit decision sheet. Usage: fsa confirm <run-dir> --source <paths...>
    const { cfg } = await parseConfig(rest);
    const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const inputRunDir = positional ?? readFlag(rest, "--run") ?? readFlag(rest, "--input");
    if (!inputRunDir) throw new Error("fsa confirm needs a prior run directory: fsa confirm <run-dir> --source <paths...>");
    if (cfg.sourcePaths.length === 0) throw new Error("--source <paths...> is required (the target code to reproduce against)");
    // Confirm is UNBOUNDED by default (run until the model finishes); --max-steps caps it only if given.
    const maxSteps = readIntFlag(rest, "--max-steps");
    const result = await runConfirm(cfg, { inputRunDir, ...(maxSteps !== undefined ? { maxSteps } : {}), streamEvents: true });
    console.log(`[confirm dir] ${result.runDir}`);
    console.log(`[report] ${result.runDir}/confirm_report.md  ← decision sheet (distinct bugs, reproduced?, novelty, recommendation)`);
    console.log(`[provenance] ${result.runDir}/confirm_provenance.json  ← fingerprints of the findings frozen before any network access`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

async function parseConfig(args: string[]): Promise<{ cfg: AuditorConfig }> {
  const cfg = defaultConfig();
  const configPath = readFlag(args, "--config");
  if (configPath) {
    applyConfigOverrides(cfg, JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>);
  }
  cfg.targetName = readFlag(args, "--target") ?? cfg.targetName;
  const sourcePaths = readMultiFlag(args, "--source");
  const corpusPaths = readMultiFlag(args, "--corpus");
  if (sourcePaths.length > 0) cfg.sourcePaths = sourcePaths;
  if (corpusPaths.length > 0) cfg.corpusPaths = corpusPaths;
  const buildRoot = readFlag(args, "--build-root");
  if (buildRoot !== undefined) cfg.buildRoot = buildRoot;
  cfg.outputDir = readFlag(args, "--out") ?? cfg.outputDir;
  const historyDir = readFlag(args, "--history-dir");
  if (historyDir !== undefined) cfg.historyDir = historyDir;
  cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
  cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
  cfg.maxTokens = readIntFlag(args, "--max-tokens") ?? cfg.maxTokens;
  cfg.reproductionCommandTimeoutMs = readIntFlag(args, "--repro-timeout-ms") ?? cfg.reproductionCommandTimeoutMs;
  cfg.auditMaxSteps = readIntFlag(args, "--max-steps") ?? cfg.auditMaxSteps;
  const scopeNote = readFlag(args, "--scope-note");
  if (scopeNote !== undefined) cfg.auditScopeNote = scopeNote;
  if (args.includes("--no-prepare")) cfg.auditPrepare = false;
  cfg.auditPrepareTimeoutMs = readIntFlag(args, "--prepare-timeout-ms") ?? cfg.auditPrepareTimeoutMs;
  if (args.includes("--no-refute")) cfg.auditRefute = false;
  if (args.includes("--no-appeal")) cfg.auditAppeal = false;
  if (args.includes("--deep")) cfg.auditDeep = true;
  cfg.auditMaxScopes = readIntFlag(args, "--max-scopes") ?? cfg.auditMaxScopes;
  cfg.auditMapSteps = readIntFlag(args, "--map-steps") ?? cfg.auditMapSteps;
  cfg.auditDigSteps = readIntFlag(args, "--dig-steps") ?? cfg.auditDigSteps;
  cfg.auditDigSamples = readIntFlag(args, "--dig-samples") ?? cfg.auditDigSamples;
  cfg.auditDigConcurrency = readIntFlag(args, "--dig-concurrency") ?? cfg.auditDigConcurrency;
  if (args.includes("--remap")) cfg.auditRemap = true;
  const scopeSel = readFlag(args, "--scope");
  if (scopeSel) {
    const ids = scopeSel.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length > 0) {
      cfg.auditScopeIds = ids;
      cfg.auditDeep = true; // picking a scope is a deep (map → dig) operation
    }
  }
  const verifyPath = readFlag(args, "--verify");
  if (verifyPath !== undefined) cfg.auditVerify = verifyPath;
  const deepFocus = readFlag(args, "--deep-focus");
  if (deepFocus !== undefined) {
    cfg.auditDeep = true;
    cfg.auditDeepFocus = deepFocus;
  }
  if (args.includes("--dry-run")) cfg.dryRun = true;
  const thinking = readFlag(args, "--thinking");
  if (thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
    cfg.thinkingLevel = thinking;
  }
  return { cfg };
}

function applyConfigOverrides(cfg: AuditorConfig, raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object") return;
  if (typeof raw.targetName === "string") cfg.targetName = raw.targetName;
  if (Array.isArray(raw.sourcePaths) && raw.sourcePaths.every((value) => typeof value === "string")) cfg.sourcePaths = raw.sourcePaths;
  if (Array.isArray(raw.corpusPaths) && raw.corpusPaths.every((value) => typeof value === "string")) cfg.corpusPaths = raw.corpusPaths;
  const rawBuildRoot = raw.buildRoot ?? raw.build_root;
  if (typeof rawBuildRoot === "string" && rawBuildRoot.trim().length > 0) cfg.buildRoot = rawBuildRoot.trim();
  if (typeof raw.outputDir === "string") cfg.outputDir = raw.outputDir;
  if (typeof raw.historyDir === "string") cfg.historyDir = raw.historyDir;
  if (typeof raw.history_dir === "string") cfg.historyDir = raw.history_dir;
  if (typeof raw.provider === "string") cfg.provider = raw.provider;
  if (typeof raw.auditModel === "string") cfg.auditModel = raw.auditModel;
  if (typeof raw.model === "string") cfg.auditModel = raw.model;
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) cfg.maxTokens = Math.max(1000, Math.floor(raw.maxTokens));
  const rawReproductionCommandTimeoutMs = raw.reproductionCommandTimeoutMs ?? raw.reproduction_command_timeout_ms;
  if (typeof rawReproductionCommandTimeoutMs === "number" && Number.isFinite(rawReproductionCommandTimeoutMs)) {
    cfg.reproductionCommandTimeoutMs = Math.max(1000, Math.floor(rawReproductionCommandTimeoutMs));
  }
  const rawAuditMaxSteps = raw.auditMaxSteps ?? raw.audit_max_steps;
  if (typeof rawAuditMaxSteps === "number" && Number.isFinite(rawAuditMaxSteps)) cfg.auditMaxSteps = Math.max(1, Math.floor(rawAuditMaxSteps));
  const rawAuditScopeNote = raw.auditScopeNote ?? raw.audit_scope_note;
  if (typeof rawAuditScopeNote === "string" && rawAuditScopeNote.trim().length > 0) cfg.auditScopeNote = rawAuditScopeNote.trim();
  const rawAuditPrepare = raw.auditPrepare ?? raw.audit_prepare;
  if (typeof rawAuditPrepare === "boolean") cfg.auditPrepare = rawAuditPrepare;
  const rawAuditPrepareTimeoutMs = raw.auditPrepareTimeoutMs ?? raw.audit_prepare_timeout_ms;
  if (typeof rawAuditPrepareTimeoutMs === "number" && Number.isFinite(rawAuditPrepareTimeoutMs)) cfg.auditPrepareTimeoutMs = Math.max(10_000, Math.floor(rawAuditPrepareTimeoutMs));
  const rawAuditRefute = raw.auditRefute ?? raw.audit_refute;
  if (typeof rawAuditRefute === "boolean") cfg.auditRefute = rawAuditRefute;
  const rawAuditAppeal = raw.auditAppeal ?? raw.audit_appeal;
  if (typeof rawAuditAppeal === "boolean") cfg.auditAppeal = rawAuditAppeal;
  const rawAuditDeep = raw.auditDeep ?? raw.audit_deep;
  if (typeof rawAuditDeep === "boolean") cfg.auditDeep = rawAuditDeep;
  const rawAuditDeepFocus = raw.auditDeepFocus ?? raw.audit_deep_focus;
  if (typeof rawAuditDeepFocus === "string" && rawAuditDeepFocus.trim().length > 0) {
    cfg.auditDeep = true;
    cfg.auditDeepFocus = rawAuditDeepFocus.trim();
  }
  const rawMaxScopes = raw.auditMaxScopes ?? raw.audit_max_scopes;
  if (typeof rawMaxScopes === "number" && Number.isFinite(rawMaxScopes)) cfg.auditMaxScopes = Math.max(1, Math.floor(rawMaxScopes));
  const rawMapSteps = raw.auditMapSteps ?? raw.audit_map_steps;
  if (typeof rawMapSteps === "number" && Number.isFinite(rawMapSteps)) cfg.auditMapSteps = Math.max(1, Math.floor(rawMapSteps));
  const rawDigSteps = raw.auditDigSteps ?? raw.audit_dig_steps;
  if (typeof rawDigSteps === "number" && Number.isFinite(rawDigSteps)) cfg.auditDigSteps = Math.max(1, Math.floor(rawDigSteps));
  const rawDigSamples = raw.auditDigSamples ?? raw.audit_dig_samples;
  if (typeof rawDigSamples === "number" && Number.isFinite(rawDigSamples)) cfg.auditDigSamples = Math.max(1, Math.floor(rawDigSamples));
  const rawDigConcurrency = raw.auditDigConcurrency ?? raw.audit_dig_concurrency;
  if (typeof rawDigConcurrency === "number" && Number.isFinite(rawDigConcurrency)) cfg.auditDigConcurrency = Math.max(1, Math.floor(rawDigConcurrency));
  if (raw.thinkingLevel === "minimal" || raw.thinkingLevel === "low" || raw.thinkingLevel === "medium" || raw.thinkingLevel === "high" || raw.thinkingLevel === "xhigh") {
    cfg.thinkingLevel = raw.thinkingLevel;
  }
  const rawModels = normalizeRoleModels(raw.models);
  if (rawModels) cfg.models = rawModels;
  if ("projectContext" in raw || "project_context" in raw) {
    cfg.projectContext = normalizeProjectContext(raw.projectContext ?? raw.project_context) ?? cfg.projectContext;
  }
  if (typeof raw.dryRun === "boolean") cfg.dryRun = raw.dryRun;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readIntFlag(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readMultiFlag(args: string[], name: string): string[] {
  const idx = args.indexOf(name);
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < args.length; i += 1) {
    const value = args[i];
    if (!value || value.startsWith("--")) break;
    out.push(value);
  }
  return out;
}

function printCoverage(runDir: string, coverage: { itemsTotal: number; itemsWithFinding: number; bySeverity: Record<string, number>; itemsNeedingRetry?: number; needsMoreContextTrials?: number; unverifiedFindings?: number }): void {
  console.log(`[run dir] ${runDir}`);
  console.log(`[coverage] findings=${coverage.itemsWithFinding}/${coverage.itemsTotal} by_severity=${JSON.stringify(coverage.bySeverity)}`);
  if ((coverage.itemsNeedingRetry ?? 0) > 0 || (coverage.needsMoreContextTrials ?? 0) > 0 || (coverage.unverifiedFindings ?? 0) > 0) {
    console.log(`[quality] retry_items=${coverage.itemsNeedingRetry ?? 0} needs_more_context_trials=${coverage.needsMoreContextTrials ?? 0} unverified_findings=${coverage.unverifiedFindings ?? 0}`);
  }
}

async function runHistoryCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "import-run") {
    throw new Error("Unknown history command. Use: fsa history import-run --target <name> --run <dir>");
  }
  const { cfg } = await parseConfig(rest);
  const runDir = readFlag(rest, "--run") ?? readFlag(rest, "--run-dir");
  if (!runDir) throw new Error("--run <dir> is required");
  const manifest = await importRunToProjectHistory({ ...projectHistoryLocation(cfg), runDir });
  const manifestPath = projectHistoryManifestPath(projectHistoryLocation(cfg));
  console.log(`[history] manifest=${manifestPath}`);
  console.log(`[history] runs=${manifest.aggregate.totalRuns} materials=${manifest.aggregate.materialsTotal} findings=${manifest.aggregate.findingsTotal}`);
}

function projectHistoryLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function printHelp(): void {
  console.log(`full-stack-auditor

Usage:
  fsa run --target <name> --source <paths...> [--corpus <paths...>] [--max-steps <n>]
  fsa confirm <run-dir> --source <paths...> [--target <name>] [--max-steps <n>]   (unbounded by default; --max-steps caps it)
  fsa history import-run --target <name> --run <dir> [--history-dir <dir>]

run is the network-SEALED discovery pass: the model finds + proves bugs blind, with no
network access (provably no online lookup). confirm is the open-world counterpart: it
freezes a prior run's findings, then — WITH the network — reproduces each against real
ground truth (e.g. a mainnet fork), consolidates duplicates into distinct bugs, checks
novelty/corroboration online (leads, never proof), and emits a submit/no-submit decision
sheet. Found blind, then confirmed open.

audit is the thin agentic mode: the model drives its own investigation with
pi-style read/write/edit/bash tools and durable cross-run memory. The framework
supplies capability and verification, not a checklist.

Options:
  --source <paths...>     code under audit; the model reads (not modifies) these. Point at a buildable root (or use --build-root) to enable execution confirmation.
  --corpus <paths...>     design/reference MATERIALS the model reads to derive what the code MUST enforce: specifications, whitepapers, design notes, protocol docs, prior audit reports, incident write-ups/post-mortems, even a relevant book chapter. Copied into the sandbox under corpus/; the map/dig prompts treat them as design intent (lens 1). This is the supported way to give the audit context — it is CONTEXT (what the system is supposed to guarantee), not answers. Do not put the suspected bug or its location here; provide the spec and let the model find the gap.
  --config <file>         JSON config with project context, models, and paths
  --provider <name>       pi-ai provider (default openai-codex); codex-cli/claude-code are CLI fallbacks
  --model <name>          set the audit model
  --history-dir <dir>     project history directory, default <out>/history
  --thinking <level>      minimal|low|medium|high|xhigh
  --max-steps <n>         audit: max agent turns/actions before stopping, default 40
  --scope-note <text>     audit: one-line authorized-scope hint for the agent
  --no-prepare            audit: skip the toolchain warm-up (deps fetch/build)
  --prepare-timeout-ms <n>
                          audit: per-command timeout for the warm-up, default 600000
  --build-root <path>     audit: directory copied into the sandbox so it is buildable (e.g. a workspace root); defaults to --source
  --no-refute             audit: skip the independent-refutation pass on confirmed findings
  --no-appeal             audit: skip the one faithful-PoC appeal a refuted finding may make
  --deep                  audit: map → dig flow (map enumerates scopes, dig deep-audits the top ones)
  --deep-focus <path>     audit: skip map and deep-audit one pinned region (implies --deep)
  --max-scopes <n>        audit: how many un-audited scopes the dig phase audits per run, default 6
  --map-steps <n>         audit: action budget for the map phase, default 20
  --dig-steps <n>         audit: per-scope action budget for the dig phase, default 30
  --dig-samples <n>       audit: independent dig passes per scope, findings unioned (raises recall), default 1
  --dig-concurrency <n>   audit: how many scopes to deep-audit in parallel (isolated workspaces), default 1
  --remap                 audit: re-enumerate scopes from scratch (default resumes the persisted inventory)
  --scope <id[,id...]>    audit: deep-audit specific scope id(s) from the inventory (implies --deep; run --deep once first to enumerate)
  --verify <file>         audit: confirm-or-refute existing suspected finding(s) by execution. <file> is JSON (one finding or an array; each: title, location, description, exploit_sketch?, fix_patch?). Skips map/dig; writes a PoC, builds, runs it through the confirmation gate + differential, and marks each confirmed-differential / confirmed-executable / REFUTED. Needs a buildable target (do not pass --no-prepare).
  --mock-llm              run with the deterministic mock model
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

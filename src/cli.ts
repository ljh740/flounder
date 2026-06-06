#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultConfig, type AuditorConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import type { AuditItem, AuditorAgentDefinition } from "./types.js";
import { loadCorpus, loadSource } from "./ingest/source.js";
import { RunLogger } from "./trace/logger.js";
import { runAudit } from "./audit/runner.js";
import { aggregate } from "./audit/aggregate.js";
import { createLlmClient } from "./llm/client.js";
import { MockAuditLlmClient } from "./llm/mock.js";
import { normalizeLensPacks, normalizeProjectContext } from "./lens/context.js";
import { resolveLastRunDir } from "./trace/last-run.js";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "run") {
    const { cfg, verifyTopK } = await parseConfig(rest);
    const resumeRunDir = await readResumeRunDir(rest, cfg.outputDir);
    const result = await runPipeline(cfg, {
      verifyTopK,
      streamEvents: true,
      ...(resumeRunDir ? { resumeRunDir } : {}),
      ...(hasFlag(rest, "--mock-llm") ? { llm: new MockAuditLlmClient() } : {}),
    });
    printCoverage(result.runDir, result.summary.coverage);
    return;
  }

  if (cmd === "audit") {
    const { cfg } = await parseConfig(rest);
    const checklistPath = readFlag(rest, "--checklist");
    if (!checklistPath) throw new Error("--checklist is required");
    const checklist = JSON.parse(await readFile(checklistPath, "utf8")) as AuditItem[];
    const logger = new RunLogger(cfg.outputDir, cfg.targetName, new Date(), { streamEvents: true });
    await logger.init();
    const source = await loadSource(cfg.sourcePaths);
    const corpus = await loadCorpus(cfg.corpusPaths);
    const llm = cfg.dryRun ? undefined : hasFlag(rest, "--mock-llm") ? new MockAuditLlmClient(logger) : createLlmClient(cfg, logger);
    const results = await runAudit({ cfg, items: checklist, source, corpus, ...(llm ? { llm } : {}), logger });
    const summary = aggregate(results);
    await logger.artifact("summary.json", summary);
    printCoverage(logger.runDir, summary.coverage);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

async function parseConfig(args: string[]): Promise<{ cfg: AuditorConfig; verifyTopK: number }> {
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
  cfg.outputDir = readFlag(args, "--out") ?? cfg.outputDir;
  cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
  cfg.enumModel = readFlag(args, "--enum-model") ?? readFlag(args, "--model") ?? cfg.enumModel;
  cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
  cfg.verifyModel = readFlag(args, "--verify-model") ?? readFlag(args, "--model") ?? cfg.verifyModel;
  cfg.rounds = readIntFlag(args, "--rounds") ?? cfg.rounds;
  cfg.explorationStrategy = readStrategyFlag(args) ?? cfg.explorationStrategy;
  cfg.maxNewItemsPerRound = readIntFlag(args, "--max-new-items-per-round") ?? cfg.maxNewItemsPerRound;
  cfg.trials = readIntFlag(args, "--trials") ?? cfg.trials;
  cfg.maxWorkers = readIntFlag(args, "--max-workers") ?? cfg.maxWorkers;
  const maxAuditItems = readIntFlag(args, "--max-items");
  if (maxAuditItems !== undefined) cfg.maxAuditItems = maxAuditItems;
  cfg.maxTokens = readIntFlag(args, "--max-tokens") ?? cfg.maxTokens;
  cfg.contextCharBudget = readIntFlag(args, "--context-chars") ?? cfg.contextCharBudget;
  cfg.contextRetrieval = readRetrievalFlag(args) ?? cfg.contextRetrieval;
  cfg.qmdCommand = readFlag(args, "--qmd-command") ?? cfg.qmdCommand;
  cfg.qmdLimit = readIntFlag(args, "--qmd-limit") ?? cfg.qmdLimit;
  cfg.qmdMinScore = readNumberFlag(args, "--qmd-min-score") ?? cfg.qmdMinScore;
  cfg.qmdTimeoutMs = readIntFlag(args, "--qmd-timeout-ms") ?? cfg.qmdTimeoutMs;
  const qmdCollections = readMultiFlag(args, "--qmd-collection");
  if (qmdCollections.length > 0) cfg.qmdCollections = qmdCollections;
  cfg.portfolioMaxItems = readIntFlag(args, "--portfolio-max-items") ?? cfg.portfolioMaxItems;
  if (args.includes("--dry-run")) cfg.dryRun = true;
  if (args.includes("--no-project-learning")) cfg.projectLearning = false;
  if (args.includes("--no-dynamic-lenses")) cfg.dynamicLensDiscovery = false;
  if (args.includes("--no-portfolio-enumeration")) cfg.portfolioEnumeration = false;
  if (cfg.dryRun && !args.includes("--no-local-seeders")) cfg.localChecklistSeeders = true;
  if (args.includes("--local-seeders")) cfg.localChecklistSeeders = true;
  if (args.includes("--no-local-seeders")) cfg.localChecklistSeeders = false;
  const thinking = readFlag(args, "--thinking");
  if (thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
    cfg.thinkingLevel = thinking;
  }
  return { cfg, verifyTopK: readIntFlag(args, "--verify-top") ?? 3 };
}

function applyConfigOverrides(cfg: AuditorConfig, raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object") return;
  if (typeof raw.targetName === "string") cfg.targetName = raw.targetName;
  if (Array.isArray(raw.sourcePaths) && raw.sourcePaths.every((value) => typeof value === "string")) cfg.sourcePaths = raw.sourcePaths;
  if (Array.isArray(raw.corpusPaths) && raw.corpusPaths.every((value) => typeof value === "string")) cfg.corpusPaths = raw.corpusPaths;
  if (typeof raw.outputDir === "string") cfg.outputDir = raw.outputDir;
  if (typeof raw.provider === "string") cfg.provider = raw.provider;
  if (typeof raw.enumModel === "string") cfg.enumModel = raw.enumModel;
  if (typeof raw.auditModel === "string") cfg.auditModel = raw.auditModel;
  if (typeof raw.verifyModel === "string") cfg.verifyModel = raw.verifyModel;
  if (typeof raw.model === "string") {
    cfg.enumModel = raw.model;
    cfg.auditModel = raw.model;
    cfg.verifyModel = raw.model;
  }
  if (typeof raw.trials === "number" && Number.isFinite(raw.trials)) cfg.trials = Math.max(1, Math.floor(raw.trials));
  if (typeof raw.rounds === "number" && Number.isFinite(raw.rounds)) cfg.rounds = Math.max(1, Math.floor(raw.rounds));
  const rawStrategy = raw.explorationStrategy ?? raw.exploration_strategy ?? raw.strategy;
  if (rawStrategy === "breadth" || rawStrategy === "depth" || rawStrategy === "hybrid") {
    cfg.explorationStrategy = rawStrategy;
  }
  const rawMaxNewItemsPerRound = raw.maxNewItemsPerRound ?? raw.max_new_items_per_round;
  if (typeof rawMaxNewItemsPerRound === "number" && Number.isFinite(rawMaxNewItemsPerRound)) {
    cfg.maxNewItemsPerRound = Math.max(1, Math.floor(rawMaxNewItemsPerRound));
  }
  if (typeof raw.maxWorkers === "number" && Number.isFinite(raw.maxWorkers)) cfg.maxWorkers = Math.max(1, Math.floor(raw.maxWorkers));
  const rawMaxAuditItems = raw.maxAuditItems ?? raw.max_audit_items;
  if (typeof rawMaxAuditItems === "number" && Number.isFinite(rawMaxAuditItems)) cfg.maxAuditItems = Math.max(1, Math.floor(rawMaxAuditItems));
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) cfg.maxTokens = Math.max(1000, Math.floor(raw.maxTokens));
  if (typeof raw.contextCharBudget === "number" && Number.isFinite(raw.contextCharBudget)) {
    cfg.contextCharBudget = Math.max(4000, Math.floor(raw.contextCharBudget));
  }
  const rawRetrieval = raw.contextRetrieval ?? raw.context_retrieval ?? raw.retrieval;
  if (rawRetrieval === "source-index" || rawRetrieval === "source-index+qmd") cfg.contextRetrieval = rawRetrieval;
  if (typeof raw.qmdCommand === "string") cfg.qmdCommand = raw.qmdCommand;
  if (typeof raw.qmdLimit === "number" && Number.isFinite(raw.qmdLimit)) cfg.qmdLimit = Math.max(1, Math.floor(raw.qmdLimit));
  if (typeof raw.qmdMinScore === "number" && Number.isFinite(raw.qmdMinScore)) cfg.qmdMinScore = Math.max(0, raw.qmdMinScore);
  const rawPortfolioMaxItems = raw.portfolioMaxItems ?? raw.portfolio_max_items;
  if (typeof rawPortfolioMaxItems === "number" && Number.isFinite(rawPortfolioMaxItems)) {
    cfg.portfolioMaxItems = Math.max(1, Math.floor(rawPortfolioMaxItems));
  }
  const rawPortfolioEnumeration = raw.portfolioEnumeration ?? raw.portfolio_enumeration;
  if (typeof rawPortfolioEnumeration === "boolean") cfg.portfolioEnumeration = rawPortfolioEnumeration;
  const rawQmdTimeoutMs = raw.qmdTimeoutMs ?? raw.qmd_timeout_ms;
  if (typeof rawQmdTimeoutMs === "number" && Number.isFinite(rawQmdTimeoutMs)) cfg.qmdTimeoutMs = Math.max(1000, Math.floor(rawQmdTimeoutMs));
  const rawQmdCollections = raw.qmdCollections ?? raw.qmd_collections ?? raw.qmdCollection ?? raw.qmd_collection;
  if (Array.isArray(rawQmdCollections) && rawQmdCollections.every((value) => typeof value === "string")) {
    cfg.qmdCollections = rawQmdCollections.filter((value) => value.trim().length > 0);
  } else if (typeof rawQmdCollections === "string" && rawQmdCollections.trim().length > 0) {
    cfg.qmdCollections = [rawQmdCollections.trim()];
  }
  if (raw.thinkingLevel === "minimal" || raw.thinkingLevel === "low" || raw.thinkingLevel === "medium" || raw.thinkingLevel === "high" || raw.thinkingLevel === "xhigh") {
    cfg.thinkingLevel = raw.thinkingLevel;
  }
  if (Array.isArray(raw.failureModes) && raw.failureModes.every((value) => typeof value === "string")) {
    cfg.failureModes = raw.failureModes as AuditorConfig["failureModes"];
  }
  if (Array.isArray(raw.auditorAgents)) {
    cfg.auditorAgents = cleanAuditorAgents(raw.auditorAgents);
  }
  if ("lensPacks" in raw || "lens_packs" in raw) cfg.lensPacks = normalizeLensPacks(raw.lensPacks ?? raw.lens_packs);
  if ("projectContext" in raw || "project_context" in raw) {
    cfg.projectContext = normalizeProjectContext(raw.projectContext ?? raw.project_context) ?? cfg.projectContext;
  }
  if (typeof raw.projectLearning === "boolean") cfg.projectLearning = raw.projectLearning;
  if (typeof raw.dynamicLensDiscovery === "boolean") cfg.dynamicLensDiscovery = raw.dynamicLensDiscovery;
  if (typeof raw.localChecklistSeeders === "boolean") cfg.localChecklistSeeders = raw.localChecklistSeeders;
  if (typeof raw.dryRun === "boolean") cfg.dryRun = raw.dryRun;
}

function cleanAuditorAgents(value: unknown[]): AuditorAgentDefinition[] {
  const packs = normalizeLensPacks([{ id: "config-agents", auditorAgents: value }]);
  return packs[0]?.auditorAgents ?? [];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function readIntFlag(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumberFlag(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStrategyFlag(args: string[]): AuditorConfig["explorationStrategy"] | undefined {
  const value = readFlag(args, "--strategy") ?? readFlag(args, "--exploration-strategy");
  return value === "breadth" || value === "depth" || value === "hybrid" ? value : undefined;
}

function readRetrievalFlag(args: string[]): AuditorConfig["contextRetrieval"] | undefined {
  const value = readFlag(args, "--retrieval") ?? readFlag(args, "--context-retrieval");
  return value === "source-index" || value === "source-index+qmd" ? value : undefined;
}

async function readResumeRunDir(args: string[], outputDir: string): Promise<string | undefined> {
  if (hasFlag(args, "--resume-last")) return resolveLastRunDir(outputDir);
  const resumeRun = readFlag(args, "--resume-run");
  if (resumeRun === "last") return resolveLastRunDir(outputDir);
  return resumeRun;
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

function printCoverage(runDir: string, coverage: { itemsTotal: number; itemsWithFinding: number; bySeverity: Record<string, number> }): void {
  console.log(`[run dir] ${runDir}`);
  console.log(`[coverage] findings=${coverage.itemsWithFinding}/${coverage.itemsTotal} by_severity=${JSON.stringify(coverage.bySeverity)}`);
}

function printHelp(): void {
  console.log(`full-stack-auditor

Usage:
  fsa run --target <name> --source <paths...> [--corpus <paths...>] [--dry-run]
  fsa audit --checklist <file> --source <paths...>

Options:
  --config <file>         JSON config with projectContext, lensPacks, agents, models, paths
  --provider <name>       pi-ai provider, codex-cli, or claude-code; default openai
  --model <name>          set enum/audit/verify model
  --enum-model <name>     model for checklist enumeration
  --audit-model <name>    model for audit trials
  --verify-model <name>   model for verification planning
  --rounds <n>            project exploration rounds, default 1
                          with --resume-run, append n additional rounds
  --strategy <name>       breadth|depth|hybrid, default hybrid
  --resume-run <dir>      continue from an existing run directory
  --resume-run last       continue from the last run under --out
  --resume-last           shorthand for --resume-run last
  --max-new-items-per-round <n>
                          cap new deepening items per round, default 16
  --trials <n>            independent trials per item, default 4
  --max-items <n>         cap total audit items across rounds for cost-controlled runs
  --thinking <level>      minimal|low|medium|high|xhigh
  --context-chars <n>     character budget per audit item context
  --retrieval <name>      source-index|source-index+qmd, default source-index
  --qmd-command <cmd>     QMD CLI command when QMD retrieval is enabled, default qmd
  --qmd-limit <n>         max QMD hits per item, default 6
  --qmd-min-score <n>     minimum QMD hit score, default 0.25
  --qmd-timeout-ms <n>    QMD query timeout, default 60000
  --qmd-collection <names...>
                          limit QMD retrieval to one or more collections
  --dry-run               no model calls; local checklist seeders only
  --no-project-learning   disable model initialization learning notes
  --no-dynamic-lenses     disable model-generated project lens packs
  --local-seeders         add deterministic local checklist seeders
  --no-local-seeders      require checklist items to come from model enumeration
  --mock-llm              run full pipeline with deterministic mock model
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

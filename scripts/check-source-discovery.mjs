#!/usr/bin/env node
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, locationContainsLine, publicLocation, runPipeline } from "../dist/index.js";

const args = process.argv.slice(2);
const existingRunDir = readFlag(args, "--run-dir");
const configPath = existingRunDir ? undefined : readFlag(args, "--config");
const source = existingRunDir || configPath ? undefined : readFlag(args, "--source") ?? process.env.FSA_DISCOVERY_SOURCE;
if (!existingRunDir && !configPath && !source) {
  throw new Error("Provide --config <file>, --source <path>, --run-dir <path>, or set FSA_DISCOVERY_SOURCE.");
}

const cfg = defaultConfig();
if (configPath) applyConfigOverrides(cfg, JSON.parse(await readFile(configPath, "utf8")));
cfg.targetName = readFlag(args, "--target") ?? cfg.targetName ?? "source-discovery";
if (source) cfg.sourcePaths = [source];
const corpusPaths = readMultiFlag(args, "--corpus");
if (corpusPaths.length > 0) cfg.corpusPaths = corpusPaths;
cfg.outputDir = existingRunDir ? path.dirname(existingRunDir) : await mkdtemp(path.join(os.tmpdir(), "fsa-source-discovery-"));
cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
cfg.enumModel = readFlag(args, "--enum-model") ?? readFlag(args, "--model") ?? cfg.enumModel;
cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
cfg.verifyModel = readFlag(args, "--verify-model") ?? readFlag(args, "--model") ?? cfg.verifyModel;
cfg.rounds = readIntFlag(args, "--rounds") ?? cfg.rounds;
cfg.explorationStrategy = readStrategyFlag(args) ?? cfg.explorationStrategy;
cfg.maxNewItemsPerRound = readIntFlag(args, "--max-new-items-per-round") ?? cfg.maxNewItemsPerRound;
cfg.trials = readIntFlag(args, "--trials") ?? cfg.trials;
cfg.maxWorkers = readIntFlag(args, "--max-workers") ?? cfg.maxWorkers;
cfg.maxAuditItems = readIntFlag(args, "--max-items") ?? cfg.maxAuditItems;
cfg.contextCharBudget = readIntFlag(args, "--context-chars") ?? cfg.contextCharBudget;
cfg.contextRetrieval = readRetrievalFlag(args) ?? cfg.contextRetrieval;
cfg.qmdCommand = readFlag(args, "--qmd-command") ?? cfg.qmdCommand;
cfg.qmdLimit = readIntFlag(args, "--qmd-limit") ?? cfg.qmdLimit;
cfg.qmdMinScore = readNumberFlag(args, "--qmd-min-score") ?? cfg.qmdMinScore;
cfg.qmdTimeoutMs = readIntFlag(args, "--qmd-timeout-ms") ?? cfg.qmdTimeoutMs;
const qmdCollections = readMultiFlag(args, "--qmd-collection");
if (qmdCollections.length > 0) cfg.qmdCollections = qmdCollections;
cfg.portfolioMaxItems = readIntFlag(args, "--portfolio-max-items") ?? cfg.portfolioMaxItems;
cfg.thinkingLevel = readThinkingFlag(args, "--thinking") ?? cfg.thinkingLevel;
if (hasFlag(args, "--no-portfolio-enumeration")) cfg.portfolioEnumeration = false;
cfg.dryRun = false;
cfg.projectLearning = !hasFlag(args, "--no-project-learning");
cfg.dynamicLensDiscovery = !hasFlag(args, "--no-dynamic-lenses");
cfg.localChecklistSeeders = hasFlag(args, "--allow-local-seeders");

const expectedFailureMode = readFlag(args, "--expect-failure-mode") ?? "missing_constraint";
const expectedFailureModeRegex = readRegexFlag(args, "--expect-failure-mode-regex");
const expectedLocation = readRegexFlag(args, "--expect-location-regex");
const expectedLocationFile = readRegexFlag(args, "--expect-location-file-regex");
const expectedLocationLine = readIntFlag(args, "--expect-location-line");
const expectedEvidence = readRegexFlag(args, "--expect-evidence-regex") ?? /(constraint|enforce|equation|guard|check|invariant|verification|binding|mismatch|authorization|validation)/i;
const minimumSeverity = readFlag(args, "--expect-min-severity") ?? readFlag(args, "--expect-severity") ?? "high";

const result = existingRunDir ? { runDir: existingRunDir } : await runPipeline(cfg, { streamEvents: true });
const calls = await readdir(path.join(result.runDir, "calls"));
const auditCalls = calls.filter((file) => /_audit_/.test(file));
const learningCalls = calls.filter((file) => /_learn_project\.json$/.test(file));
const enumerateCalls = calls.filter((file) => /_enumerate\.json$/.test(file));
if (cfg.projectLearning && learningCalls.length === 0) {
  throw new Error("No initialization learning model call was recorded; project learning did not run as model reasoning.");
}
if (enumerateCalls.length === 0) {
  throw new Error("No enumeration model call was recorded; checklist generation did not run as model reasoning.");
}
if (auditCalls.length === 0) {
  throw new Error("No audit model calls were recorded; live model reasoning did not run.");
}

const summary = JSON.parse(await readFile(path.join(result.runDir, "summary.json"), "utf8"));
const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
const findings = Array.isArray(summary.findings) ? summary.findings : [];
const finding = findings.find((item) => {
  if (expectedFailureModeRegex ? !expectedFailureModeRegex.test(item.failureMode) : item.failureMode !== expectedFailureMode) return false;
  if (!atLeastSeverity(item.severity, minimumSeverity)) return false;
  if (expectedLocation && !expectedLocation.test(item.location)) return false;
  if (expectedLocationFile && expectedLocationLine === undefined && !expectedLocationFile.test(item.location)) return false;
  if (expectedLocationLine !== undefined && !locationContainsLine(item.location, expectedLocationLine, expectedLocationFile)) return false;
  const evidenceText = [item.title, item.description, item.evidence, item.fix].join("\n");
  return expectedEvidence.test(evidenceText);
});

if (!finding) {
  const failureModeLabel = expectedFailureModeRegex ? `/${expectedFailureModeRegex.source}/i` : expectedFailureMode;
  const locationLabel = expectedLocationLine === undefined ? "" : ` expectedLine=${expectedLocationLine}`;
  throw new Error(`No live model finding matched failureMode=${failureModeLabel} minSeverity=${minimumSeverity}${locationLabel}.`);
}

const checklistItem = Array.isArray(checklist) ? checklist.find((item) => item.id === finding.id) : undefined;
if (!cfg.localChecklistSeeders && checklistItem?.seeder) {
  throw new Error(`Matched finding came from local checklist seeder '${checklistItem.seeder}', not model enumeration.`);
}

const report = await readFile(path.join(result.runDir, `report_${finding.id}.md`), "utf8");
if (!report.includes("Security disclosure")) {
  throw new Error("Matched finding did not produce a disclosure report.");
}

console.log(`Model source discovery check passed: ${finding.severity} ${publicLocation(finding.location)}`);

function hasFlag(values, name) {
  return values.includes(name);
}

function readFlag(values, name) {
  const idx = values.indexOf(name);
  if (idx === -1) return undefined;
  return values[idx + 1];
}

function readIntFlag(values, name) {
  const value = readFlag(values, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumberFlag(values, name) {
  const value = readFlag(values, name);
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readThinkingFlag(values, name) {
  const value = readFlag(values, name);
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function readRetrievalFlag(values) {
  const value = readFlag(values, "--retrieval") ?? readFlag(values, "--context-retrieval");
  return value === "source-index" || value === "source-index+qmd" ? value : undefined;
}

function readStrategyFlag(values) {
  const value = readFlag(values, "--strategy") ?? readFlag(values, "--exploration-strategy");
  return value === "breadth" || value === "depth" || value === "hybrid" ? value : undefined;
}

function readRegexFlag(values, name) {
  const value = readFlag(values, name);
  return value ? new RegExp(value, "i") : undefined;
}

function readMultiFlag(values, name) {
  const idx = values.indexOf(name);
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < values.length; i += 1) {
    const value = values[i];
    if (!value || value.startsWith("--")) break;
    out.push(value);
  }
  return out;
}

function atLeastSeverity(actual, minimum) {
  const rank = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
  return (rank[actual] ?? 0) >= (rank[minimum] ?? 4);
}

function applyConfigOverrides(cfg, raw) {
  if (!raw || typeof raw !== "object") return;
  if (typeof raw.targetName === "string") cfg.targetName = raw.targetName;
  if (Array.isArray(raw.sourcePaths) && raw.sourcePaths.every(isString)) cfg.sourcePaths = raw.sourcePaths;
  if (Array.isArray(raw.corpusPaths) && raw.corpusPaths.every(isString)) cfg.corpusPaths = raw.corpusPaths;
  if (typeof raw.outputDir === "string") cfg.outputDir = raw.outputDir;
  if (typeof raw.provider === "string") cfg.provider = raw.provider;
  if (typeof raw.model === "string") cfg.enumModel = cfg.auditModel = cfg.verifyModel = raw.model;
  if (typeof raw.enumModel === "string") cfg.enumModel = raw.enumModel;
  if (typeof raw.auditModel === "string") cfg.auditModel = raw.auditModel;
  if (typeof raw.verifyModel === "string") cfg.verifyModel = raw.verifyModel;
  if (isFiniteNumber(raw.rounds)) cfg.rounds = Math.max(1, Math.floor(raw.rounds));
  if (isFiniteNumber(raw.trials)) cfg.trials = Math.max(1, Math.floor(raw.trials));
  if (isFiniteNumber(raw.maxWorkers)) cfg.maxWorkers = Math.max(1, Math.floor(raw.maxWorkers));
  if (isFiniteNumber(raw.maxAuditItems ?? raw.max_audit_items)) cfg.maxAuditItems = Math.max(1, Math.floor(raw.maxAuditItems ?? raw.max_audit_items));
  if (isFiniteNumber(raw.maxNewItemsPerRound ?? raw.max_new_items_per_round)) {
    cfg.maxNewItemsPerRound = Math.max(1, Math.floor(raw.maxNewItemsPerRound ?? raw.max_new_items_per_round));
  }
  if (isFiniteNumber(raw.contextCharBudget ?? raw.context_char_budget)) {
    cfg.contextCharBudget = Math.max(4000, Math.floor(raw.contextCharBudget ?? raw.context_char_budget));
  }
  const retrieval = raw.contextRetrieval ?? raw.context_retrieval ?? raw.retrieval;
  if (retrieval === "source-index" || retrieval === "source-index+qmd") cfg.contextRetrieval = retrieval;
  const strategy = raw.explorationStrategy ?? raw.exploration_strategy ?? raw.strategy;
  if (strategy === "breadth" || strategy === "depth" || strategy === "hybrid") cfg.explorationStrategy = strategy;
  if (raw.thinkingLevel === "minimal" || raw.thinkingLevel === "low" || raw.thinkingLevel === "medium" || raw.thinkingLevel === "high" || raw.thinkingLevel === "xhigh") {
    cfg.thinkingLevel = raw.thinkingLevel;
  }
  if (typeof raw.qmdCommand === "string") cfg.qmdCommand = raw.qmdCommand;
  if (isFiniteNumber(raw.qmdLimit)) cfg.qmdLimit = Math.max(1, Math.floor(raw.qmdLimit));
  if (isFiniteNumber(raw.qmdMinScore)) cfg.qmdMinScore = Math.max(0, raw.qmdMinScore);
  if (isFiniteNumber(raw.qmdTimeoutMs ?? raw.qmd_timeout_ms)) cfg.qmdTimeoutMs = Math.max(1000, Math.floor(raw.qmdTimeoutMs ?? raw.qmd_timeout_ms));
  const qmdCollections = raw.qmdCollections ?? raw.qmd_collections ?? raw.qmdCollection ?? raw.qmd_collection;
  if (Array.isArray(qmdCollections) && qmdCollections.every(isString)) cfg.qmdCollections = qmdCollections;
  if (typeof qmdCollections === "string" && qmdCollections.trim().length > 0) cfg.qmdCollections = [qmdCollections.trim()];
  if (isFiniteNumber(raw.portfolioMaxItems ?? raw.portfolio_max_items)) cfg.portfolioMaxItems = Math.max(1, Math.floor(raw.portfolioMaxItems ?? raw.portfolio_max_items));
  const portfolioEnumeration = raw.portfolioEnumeration ?? raw.portfolio_enumeration;
  if (typeof portfolioEnumeration === "boolean") cfg.portfolioEnumeration = portfolioEnumeration;
  if (typeof raw.projectLearning === "boolean") cfg.projectLearning = raw.projectLearning;
  if (typeof raw.dynamicLensDiscovery === "boolean") cfg.dynamicLensDiscovery = raw.dynamicLensDiscovery;
  if (typeof raw.localChecklistSeeders === "boolean") cfg.localChecklistSeeders = raw.localChecklistSeeders;
  if (raw.projectContext && typeof raw.projectContext === "object") cfg.projectContext = raw.projectContext;
  if (raw.project_context && typeof raw.project_context === "object") cfg.projectContext = raw.project_context;
}

function isString(value) {
  return typeof value === "string";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

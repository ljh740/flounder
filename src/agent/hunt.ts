import path from "node:path";
import { withRole, type AuditorConfig } from "../config.js";
import { loadCorpus, loadSource } from "../ingest/source.js";
import { createLlmClient } from "../llm/client.js";
import { renderDisclosure, reportArtifactName } from "../reports/disclosure.js";
import { projectHistoryDir, projectHistoryManifestPath, updateProjectHistory } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { AuditSummary, ConfirmationStatus, Doc, LlmClient, RankedFinding, Severity } from "../types.js";
import { publicPath } from "../util/paths.js";
import { listWorkspaceFiles, normalizeRelativePath, prepareSandboxWorkspace, writeSandboxFiles, type SandboxWorkspace } from "../security/sandbox.js";
import { runDifferentialConfirmation, type DifferentialResult } from "./differential.js";
import { runRefutation } from "./refutation.js";
import { runHuntLoop } from "./loop.js";
import { ProjectMemory } from "./memory.js";
import { loadScopeInventory, saveScopeInventory, scopeProgress } from "./scope-store.js";
import { isPiSessionProvider, runHuntSession } from "./pi-session.js";
import type { TranscriptStep } from "./prompts.js";
import { buildTools, clearScratchFindings, ingestFindingsFromScratch, newSession, readScratchScopes, type AgentFinding, type AuditScope, type ToolContext } from "./tools.js";

// Orchestrates one autonomous hunt: load authorized material, give the model the
// capability surface, run the ReAct loop, then turn whatever it proved into the
// same finding/summary/report/history artifacts the rest of the toolchain uses.
// All discrimination about *what* is a bug comes from the model; this function
// only wires capability, persistence, and reporting around it.

export interface HuntResult {
  runDir: string;
  summary: AuditSummary;
  /** Scope-inventory coverage for the resumable map → dig flow (omitted otherwise). */
  scopeCoverage?: { total: number; audited: number; pending: number };
}

export async function runHunt(
  cfg: AuditorConfig,
  options: { llm?: LlmClient; streamEvents?: boolean } = {},
): Promise<HuntResult> {
  const startedAt = new Date();
  const logger = new RunLogger(cfg.outputDir, cfg.targetName, startedAt, { streamEvents: options.streamEvents ?? false });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);

  const source = await loadSource(cfg.sourcePaths);
  const corpus = await loadCorpus(cfg.corpusPaths);
  await logger.event("hunt_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: cfg.provider,
    model: cfg.auditModel,
    maxSteps: cfg.huntMaxSteps,
    sourceDocs: source.length,
    corpusDocs: corpus.length,
  });

  if (source.length === 0) throw new Error("hunt requires at least one source file (use --source)");

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(cfg)), "memory.jsonl"));
  const session = newSession();
  const tools = buildTools();
  const ctx: ToolContext = { cfg, source, corpus, memory, logger, session };

  // Create the shared isolated workspace up front. It is the sandbox for tools
  // and the cwd for the agent session. The toolchain warm-up is lazy (run by the
  // bash tool on the first test command) so read-only or unauthenticated runs do
  // not pay for it.
  let workspaceCwd = process.cwd();
  const corpusManifest: string[] = [];
  if (cfg.sourcePaths.length > 0) {
    const workspace = await prepareSandboxWorkspace(cfg.sourcePaths, logger.runDir, "hunt/workspace");
    session.workspace = workspace;
    workspaceCwd = workspace.absolute;
    // Capture the pristine target source before anything else touches the
    // workspace, so the model cannot modify the code it is auditing — a
    // confirmation must run against untampered source.
    session.baselineFiles = await listWorkspaceFiles(workspace.absolute);
    // Make corpus (specs, papers, books) visible to the agent: copy it into the
    // workspace so the model can read/grep it, and list it in the manifest. This
    // reference material is often what makes a subtle bug discoverable.
    corpusManifest.push(...(await copyCorpusIntoWorkspace(workspace, corpus)));
  }

  const scopeNote = resolveScopeNote(cfg);
  // Surface prior-run lessons at kickoff: the most relevant notes for this scope,
  // falling back to the most recent ones so memory is always visible.
  let memoryNotes = await memory.recall([cfg.targetName, scopeNote].filter(Boolean).join(" "), 8);
  if (memoryNotes.length === 0) memoryNotes = (await memory.all()).slice(-8).reverse();
  const memoryHint = renderMemoryHint(memoryNotes);

  // Driver choice: real pi providers (e.g. openai-codex) run a continuous
  // AgentSession that owns the loop; the deterministic mock and CLI fallbacks use
  // the legacy per-step complete() loop.
  const fileManifest = renderFileManifest(source, corpusManifest);

  // One phase = one driver run (continuous pi session for pi providers, else the
  // per-step loop), specialized to a role's model and a mode (breadth/map/dig).
  const runPhase = async (
    phaseCfg: AuditorConfig,
    opts: { mode: "breadth" | "map" | "dig"; deepFocus?: string; maxSteps: number },
  ): Promise<{ steps: TranscriptStep[]; stoppedReason: string }> => {
    const flags = {
      ...(opts.mode === "dig" ? { deep: true } : {}),
      ...(opts.mode === "map" ? { map: true } : {}),
      ...(opts.deepFocus ? { deepFocus: opts.deepFocus } : {}),
    };
    if (!options.llm && isPiSessionProvider(phaseCfg.provider)) {
      return runHuntSession({
        cfg: { ...phaseCfg, huntMaxSteps: opts.maxSteps },
        ctx,
        tools,
        logger,
        cwd: workspaceCwd,
        fileManifest,
        ...(scopeNote ? { scopeNote } : {}),
        ...(memoryHint ? { memoryHint } : {}),
        ...flags,
      });
    }
    const llm = options.llm ?? createLlmClient(phaseCfg, logger);
    if (llm && "setLogger" in llm && typeof (llm as { setLogger?: unknown }).setLogger === "function") {
      (llm as { setLogger(logger: RunLogger): void }).setLogger(logger);
    }
    return runHuntLoop({
      cfg: phaseCfg,
      llm,
      tools,
      ctx,
      logger,
      maxSteps: Math.max(1, Math.floor(opts.maxSteps)),
      fileManifest,
      ...(scopeNote ? { scopeNote } : {}),
      ...(memoryHint ? { memoryHint } : {}),
      ...flags,
    });
  };

  let steps: TranscriptStep[];
  let stoppedReason: string;
  let manualFindings = false;
  let scopeInventory: AuditScope[] = [];

  if (cfg.huntDeep && !cfg.huntDeepFocus) {
    // MAP → DIG, resumable. The complete scope inventory is persisted under the
    // project history dir; each run deep-audits the next batch of un-audited
    // scopes and updates their status. Re-running the same command therefore
    // continues with the scopes not yet audited instead of re-mapping or
    // re-digging. --remap discards the persisted inventory and enumerates afresh.
    const inventoryDir = projectHistoryDir(historyLocation(cfg));
    const aggregatedSteps: TranscriptStep[] = [];
    scopeInventory = cfg.huntRemap ? [] : await loadScopeInventory(inventoryDir);
    const resuming = scopeInventory.length > 0;
    if (!resuming) {
      const mapPhase = await runPhase(withRole(cfg, "map"), { mode: "map", maxSteps: cfg.huntMapSteps });
      scopeInventory = readScratchScopes(session);
      aggregatedSteps.push(...mapPhase.steps);
      await logger.event("hunt_map_done", { scopes: scopeInventory.length });
      clearScratchFindings(session);
    } else {
      await logger.event("hunt_map_resumed", { ...scopeProgress(scopeInventory) });
    }
    for (const scope of scopeInventory) if (!scope.status) scope.status = "pending";

    const digCfg = withRole(cfg, "dig");
    // Audit the highest-scored scopes not yet audited; the rest stay pending for
    // a future run (visible, never silently dropped).
    const toDig = scopeInventory
      .filter((scope) => scope.status !== "audited")
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, cfg.huntMaxScopes));
    const aggregated: AgentFinding[] = [];
    for (const scope of toDig) {
      clearScratchFindings(session);
      const dig = await runPhase(digCfg, {
        mode: "dig",
        deepFocus: `${scope.obligation} — code region: ${scope.region}`,
        maxSteps: cfg.huntDigSteps,
      });
      aggregatedSteps.push(...dig.steps);
      ingestFindingsFromScratch(session);
      for (const finding of session.findings) {
        finding.scopeId = scope.id;
        aggregated.push(finding);
      }
      scope.status = "audited";
      await logger.event("hunt_dig_done", { scope: scope.id, findings: session.findings.length });
    }
    session.findings = aggregated;
    session.counters.finding = aggregated.length;
    manualFindings = true;
    steps = aggregatedSteps;
    stoppedReason = "finished";
    await saveScopeInventory(inventoryDir, scopeInventory);
    await logger.artifact("hunt_scopes.json", scopeInventory);
    await logger.event("hunt_scope_progress", { ...scopeProgress(scopeInventory), resumed: resuming });
  } else {
    // Single run: breadth (default role) or a pinned deep-focus dig (dig role).
    const pinned = Boolean(cfg.huntDeep && cfg.huntDeepFocus);
    const result = await runPhase(withRole(cfg, pinned ? "dig" : "default"), {
      mode: pinned ? "dig" : "breadth",
      ...(cfg.huntDeepFocus ? { deepFocus: cfg.huntDeepFocus } : {}),
      maxSteps: cfg.huntMaxSteps,
    });
    steps = result.steps;
    stoppedReason = result.stoppedReason;
  }

  const findingParse = manualFindings ? { parsed: session.findings.length, errors: [] } : ingestFindingsFromScratch(session);
  if (findingParse.errors.length > 0) {
    await logger.artifact("hunt_findings_errors.json", findingParse.errors);
    await logger.event("hunt_findings_parse_errors", { errors: findingParse.errors.length });
  }

  // Differential confirmation: for confirmed-executable findings that declared a
  // machine-applicable fix, apply it to the pristine target source and re-run the
  // same exploit test. A real bug's test is blocked by its fix; a tautology is
  // not. Survivors reach the strongest status, confirmed-differential.
  if (session.workspace && session.baselineFiles) {
    const differentials: DifferentialResult[] = [];
    for (const finding of session.findings) {
      if (finding.confirmationStatus !== "confirmed-executable" || !finding.fixPatch || !finding.commandRunId) continue;
      const exploitRun = session.commandRuns.find((run) => run.id === finding.commandRunId);
      if (!exploitRun) continue;
      const result = await runDifferentialConfirmation({ workspace: session.workspace, finding, exploitRun, baselineFiles: session.baselineFiles, cfg, logger });
      differentials.push(result);
      if (result.confirmed) finding.confirmationStatus = "confirmed-differential";
    }
    if (differentials.length > 0) await logger.artifact("hunt_differential.json", differentials);
  }

  // Independent refutation: a fresh-context skeptic re-derives the invariant and
  // tries to break each confirmed finding. A single-test confirmation it debunks
  // is downgraded to a hypothesis; an execution-proven (differential) finding it
  // disputes is kept but flagged for humans (execution is ground truth).
  if (cfg.huntRefute) {
    const candidates = session.findings.filter((finding) => isConfirmed(finding.confirmationStatus));
    if (candidates.length > 0) {
      const refuteCfg = withRole(cfg, "refute");
      const refuteLlm = options.llm ?? createLlmClient(refuteCfg, logger);
      const verdicts = await runRefutation({ findings: candidates, source, cfg: refuteCfg, llm: refuteLlm, logger, max: 8 });
      for (const finding of candidates) {
        if (!finding.refutation?.refuted) continue;
        if (finding.confirmationStatus === "confirmed-executable") finding.confirmationStatus = "suspected";
        else if (finding.confirmationStatus === "confirmed-differential") finding.disputed = true;
      }
      if (verdicts.length > 0) await logger.artifact("hunt_refutation.json", verdicts);
    }
  }

  // Hard artifact semantics: only an execution-confirmed candidate is a finding.
  // Everything else is a hypothesis. Hypotheses are surfaced as their own artifact
  // (not buried), but they do not get disclosure reports and are not counted as
  // findings — that is the whole point of the confirmation gate.
  const confirmed = session.findings.filter((finding) => isConfirmed(finding.confirmationStatus));
  const hypotheses = session.findings.filter((finding) => !isConfirmed(finding.confirmationStatus));

  await logger.artifact("hunt_transcript.json", { stoppedReason, steps });
  await logger.artifact("hunt_findings.json", confirmed);
  await logger.artifact("hunt_hypotheses.json", hypotheses);
  await logger.artifact("hunt_command_runs.json", session.commandRuns);

  const summary = buildSummary(confirmed, hypotheses, steps);
  await logger.artifact("summary.json", summary);

  for (const finding of summary.findings) {
    await logger.artifact(reportArtifactName(finding.id), renderDisclosure(cfg.targetName, finding));
  }

  await persistFindingMemory(memory, confirmed, hypotheses);

  await logger.event("hunt_done", {
    stoppedReason,
    steps: steps.length,
    findings: confirmed.length,
    hypotheses: hypotheses.length,
    confirmedExecutable: confirmed.length,
    commandRuns: session.commandRuns.length,
    finishSummary: session.finishSummary ?? "",
  });
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);

  const history = await updateProjectHistory({
    cfg,
    runDir: logger.runDir,
    summary,
    items: [],
    results: [],
    completedRounds: 1,
    startedAt: startedAt.toISOString(),
  });
  await logger.event("project_history_updated", {
    target: cfg.targetName,
    runs: history.aggregate.totalRuns,
    materials: history.aggregate.materialsTotal,
    manifest: publicPath(projectHistoryManifestPath(historyLocation(cfg))),
  });

  return {
    runDir: logger.runDir,
    summary,
    ...(scopeInventory.length > 0 ? { scopeCoverage: scopeProgress(scopeInventory) } : {}),
  };
}

function buildSummary(confirmed: AgentFinding[], hypotheses: AgentFinding[], steps: { tool: string }[]): AuditSummary {
  const ranked = confirmed.map(toRankedFinding).sort((a, b) => b.score - a.score);
  const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of ranked) bySeverity[finding.severity] += 1;
  return {
    coverage: {
      itemsTotal: ranked.length + hypotheses.length,
      itemsWithFinding: ranked.length,
      bySeverity,
      itemsNeedingRetry: 0,
      modelErrorTrials: steps.filter((step) => step.tool === "(model-error)").length,
      parseErrorTrials: steps.filter((step) => step.tool === "(parse-error)").length,
      needsMoreContextTrials: 0,
      verifiedFindings: ranked.length,
      unverifiedFindings: 0,
      hypotheses: hypotheses.length,
    },
    findings: ranked,
  };
}

async function persistFindingMemory(memory: ProjectMemory, confirmed: AgentFinding[], hypotheses: AgentFinding[]): Promise<void> {
  for (const finding of confirmed) {
    await memory.remember({
      note: `${finding.title} (${finding.confirmationStatus}) at ${finding.location}: ${finding.description}`.slice(0, 600),
      kind: "finding",
      tags: ["hunt", finding.severity, finding.confirmationStatus],
      sourceRef: finding.location,
    });
  }
  // Remember hypotheses too, but as notes — a future run starts knowing which
  // leads were explored without treating them as established findings.
  for (const finding of hypotheses) {
    await memory.remember({
      note: `Unconfirmed hypothesis: ${finding.title} at ${finding.location}: ${finding.description}`.slice(0, 600),
      kind: "note",
      tags: ["hunt", "hypothesis", finding.severity],
      sourceRef: finding.location,
    });
  }
}

function isConfirmed(status: ConfirmationStatus): boolean {
  return status === "confirmed-executable" || status === "confirmed-differential";
}

function toRankedFinding(finding: AgentFinding): RankedFinding {
  const severityWeight: Record<Severity, number> = { info: 0.2, low: 0.4, medium: 0.6, high: 0.85, critical: 1 };
  const confirmBoost = finding.confirmationStatus === "confirmed-differential" ? 1.5 : finding.confirmationStatus === "confirmed-executable" ? 1.3 : 1;
  const score = round2(severityWeight[finding.severity] * (0.5 + 0.5 * finding.confidence) * confirmBoost);
  return {
    id: finding.id,
    location: finding.location,
    failureMode: "autonomous",
    title: finding.title,
    severity: finding.severity,
    hitRate: 1,
    confidence: finding.confidence,
    score,
    description: finding.description,
    evidence: finding.evidence,
    exploitSketch: finding.exploitSketch,
    fix: finding.fix,
    confirmationStatus: finding.confirmationStatus,
    ...(isConfirmed(finding.confirmationStatus) ? { reproductionStatus: "confirmed-executable" as const } : {}),
    ...(finding.disputed ? { disputed: true } : {}),
    ...(finding.refutation?.refuted ? { refutationReason: finding.refutation.reason } : {}),
  };
}

function resolveScopeNote(cfg: AuditorConfig): string {
  const parts: string[] = [];
  if (cfg.huntScopeNote) parts.push(cfg.huntScopeNote);
  if (cfg.projectContext.summary) parts.push(cfg.projectContext.summary);
  if (cfg.projectContext.focusAreas?.length) parts.push(`Focus areas: ${cfg.projectContext.focusAreas.join("; ")}`);
  if (cfg.projectContext.outOfScope?.length) parts.push(`Out of scope: ${cfg.projectContext.outOfScope.join("; ")}`);
  return parts.join("\n");
}

function renderMemoryHint(notes: { kind: string; note: string; sourceRef?: string }[]): string {
  if (notes.length === 0) return "";
  return notes.map((note) => `- [${note.kind}] ${note.note}${note.sourceRef ? ` (ref: ${note.sourceRef})` : ""}`).join("\n");
}

function renderFileManifest(source: Doc[], corpusEntries: string[] = []): string {
  const lines = source.slice(0, 600).map((doc) => `- ${doc.path} (${doc.content ? doc.content.split("\n").length : 0} lines)`);
  const more = source.length > 600 ? `\n…and ${source.length - 600} more files` : "";
  let out = `${lines.join("\n")}${more}`;
  if (corpusEntries.length > 0) {
    const shown = corpusEntries.slice(0, 200).map((entry) => `- ${entry}`);
    const moreCorpus = corpusEntries.length > 200 ? `\n…and ${corpusEntries.length - 200} more` : "";
    out += `\n\nReference material (specs, papers, books) under corpus/:\n${shown.join("\n")}${moreCorpus}`;
  }
  return out;
}

async function copyCorpusIntoWorkspace(workspace: SandboxWorkspace, corpus: Doc[]): Promise<string[]> {
  if (corpus.length === 0) return [];
  const seen = new Set<string>();
  const files = corpus.map((doc, index) => {
    const safe = normalizeRelativePath(doc.path) ?? `doc-${index}`;
    let rel = `corpus/${safe}`;
    while (seen.has(rel)) rel = `corpus/${index}-${safe}`;
    seen.add(rel);
    return { path: rel, content: doc.content };
  });
  await writeSandboxFiles(workspace.absolute, files);
  return files.map((file) => file.path);
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

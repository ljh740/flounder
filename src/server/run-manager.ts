// Run-manager: launches and supervises audits so a UI/agent can run them across projects
// concurrently. It calls the LIBRARY in-process (runAudit / runConfirm) rather than shelling
// out to the CLI — the CLI is just a thin wrapper over the same functions, so calling them
// directly yields the rich result objects (AuditRunResult / ConfirmRunResult) and finer
// hooks (an AbortSignal for stop, an onRun callback for the DB run id). The audit's heavy
// work (builds, tests) still runs in sandboxed subprocesses spawned by the bash tool.

import { runAudit, type AuditRunResult } from "../agent/audit.js";
import { runConfirm, type ConfirmRunResult } from "../agent/confirm.js";
import { defaultConfig, type AuditorConfig } from "../config.js";
import { MockAuditLlmClient } from "../llm/mock.js";
import type { MetadataStore, RunKind, RunStatus } from "../db/store.js";

const DEFAULT_OUT = "runs";
const THINKING = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export type Activity = { kind: string; delta?: string; tool?: string; step?: number };

// In-memory per-run feed of the model's streaming activity (token-level thinking/output +
// tool calls), for live UI streaming without per-token disk writes. Keeps a recent ring
// buffer so a late subscriber gets backlog, then live events.
export class ActivityBus {
  private readonly buffer: Activity[] = [];
  private readonly listeners = new Set<(ev: Activity) => void>();
  push(ev: Activity): void {
    this.buffer.push(ev);
    if (this.buffer.length > 2000) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(ev);
      } catch {
        // a broken listener must not stop the run
      }
    }
  }
  subscribe(fn: (ev: Activity) => void): () => void {
    for (const ev of this.buffer) fn(ev); // replay backlog
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export interface LaunchSpec {
  verb: RunKind; // run | map | audit | confirm (verify is an audit selector)
  target: string;
  sourcePaths: string[];
  buildRoot?: string | undefined;
  corpusPaths?: string[] | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  maxScopes?: number | undefined;
  mapSteps?: number | undefined;
  digSteps?: number | undefined;
  maxSteps?: number | undefined;
  digSamples?: number | undefined;
  digConcurrency?: number | undefined;
  remap?: boolean | undefined; // run/map/audit: re-enumerate the scope inventory (restart)
  fresh?: boolean | undefined; // confirm: ignore a prior interrupted confirm
  inputRunDir?: string | undefined; // confirm: the finished run dir to reproduce
  region?: string | undefined; // audit: a pinned region
  scope?: string | undefined; // audit: scope id[,id...]
  quick?: boolean | undefined; // run: a single breadth pass instead of map -> audit
  mockLlm?: boolean | undefined; // run with the deterministic offline model (no provider needed)
  out?: string | undefined;
}

export interface ActiveRun {
  runId: number | undefined; // the DB run id (once runAudit has recorded it)
  target: string;
  verb: RunKind;
  startedAt: string;
}

interface RunHandle {
  spec: LaunchSpec;
  abort: AbortController;
  startedAt: string;
  status: "running" | "done" | "error" | "killed";
  runId?: number;
  result?: AuditRunResult | ConfirmRunResult;
  error?: string;
  activity: ActivityBus;
}

// Translate a launch spec into an AuditorConfig — the in-process equivalent of the CLI's
// parseConfig + applyAuditPosture. Budgets are UNBOUNDED unless the spec caps them.
export function specToConfig(spec: LaunchSpec, out: string): AuditorConfig {
  const cfg = defaultConfig();
  cfg.targetName = spec.target;
  cfg.sourcePaths = spec.sourcePaths;
  cfg.corpusPaths = spec.corpusPaths ?? [];
  if (spec.buildRoot) cfg.buildRoot = spec.buildRoot;
  if (spec.provider) cfg.provider = spec.provider;
  if (spec.model) cfg.auditModel = spec.model;
  if (spec.thinking && THINKING.has(spec.thinking)) cfg.thinkingLevel = spec.thinking as AuditorConfig["thinkingLevel"];
  cfg.outputDir = out;
  cfg.auditMaxSteps = spec.maxSteps ?? Number.POSITIVE_INFINITY;
  cfg.auditMapSteps = spec.mapSteps ?? Number.POSITIVE_INFINITY;
  cfg.auditDigSteps = spec.digSteps ?? Number.POSITIVE_INFINITY;
  if (spec.maxScopes !== undefined) cfg.auditMaxScopes = spec.maxScopes;
  if (spec.digSamples !== undefined) cfg.auditDigSamples = spec.digSamples;
  if (spec.digConcurrency !== undefined) cfg.auditDigConcurrency = spec.digConcurrency;
  if (spec.remap) cfg.auditRemap = true; // re-enumerate scopes from scratch (restart)
  if (spec.verb === "confirm") return cfg; // confirm derives its own posture from the prior run
  if (spec.verb === "map") {
    cfg.auditDeep = true;
    cfg.auditMapOnly = true;
  } else if (spec.verb === "audit") {
    cfg.auditDeep = true;
    if (spec.region) {
      cfg.auditDeepFocus = spec.region;
    } else {
      cfg.auditRequireInventory = true; // dig the existing inventory; never auto-map here
      const ids = (spec.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) cfg.auditScopeIds = ids;
    }
  } else if (!spec.quick) {
    cfg.auditDeep = true; // run = map -> dig, unless --quick (breadth)
  }
  return cfg;
}

export class RunManager {
  private readonly runs = new Map<number, RunHandle>();
  private nextLaunchId = 1;

  constructor(
    private readonly store: MetadataStore,
    private readonly out: string = DEFAULT_OUT,
  ) {}

  /** Launch a run in-process. Returns a launch id; the DB run id appears once runAudit
   * records it (poll GET /api/projects/:name or /api/runs). */
  launch(spec: LaunchSpec): { launchId: number; verb: RunKind } {
    const launchId = this.nextLaunchId++;
    const abort = new AbortController();
    const handle: RunHandle = { spec, abort, startedAt: new Date().toISOString(), status: "running", activity: new ActivityBus() };
    this.runs.set(launchId, handle);
    const onRun = (runId: number): void => {
      handle.runId = runId;
    };
    const onActivity = (ev: Activity): void => handle.activity.push(ev);
    // Promise.resolve().then(...) so a synchronous build error becomes a rejection, not a throw.
    void Promise.resolve()
      .then(() => this.execute(spec, abort.signal, onRun, onActivity))
      .then(
        (result) => {
          handle.result = result;
          handle.status = abort.signal.aborted ? "killed" : "done";
        },
        (error) => {
          handle.status = abort.signal.aborted ? "killed" : "error";
          handle.error = error instanceof Error ? error.message : String(error);
          // A crash before runAudit's own finalize leaves the DB row "running"; reconcile it.
          if (handle.runId !== undefined) this.reconcile(handle.runId, handle.status === "killed" ? "killed" : "error");
        },
      );
    return { launchId, verb: spec.verb };
  }

  private execute(spec: LaunchSpec, signal: AbortSignal, onRun: (runId: number) => void, onActivity: (ev: Activity) => void): Promise<AuditRunResult | ConfirmRunResult> {
    const cfg = specToConfig(spec, spec.out ?? this.out);
    if (spec.verb === "confirm") {
      if (!spec.inputRunDir) throw new Error("confirm requires inputRunDir (the finished run directory)");
      return runConfirm(cfg, {
        inputRunDir: spec.inputRunDir,
        signal,
        onRun,
        onActivity,
        ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
        ...(spec.fresh ? { fresh: true } : {}),
      });
    }
    return runAudit(cfg, {
      kind: spec.verb,
      signal,
      onRun,
      onActivity,
      ...(spec.mockLlm ? { llm: new MockAuditLlmClient() } : {}),
    });
  }

  /** The live activity bus for a run launched this session (token-level thinking/output +
   * tool calls), or undefined for runs not in this session (use the persisted event log). */
  activityFor(runId: number): ActivityBus | undefined {
    for (const handle of this.runs.values()) if (handle.runId === runId) return handle.activity;
    return undefined;
  }

  /** Request a cooperative stop of a running run (by its DB run id). */
  stop(runId: number): boolean {
    for (const handle of this.runs.values()) {
      if (handle.runId === runId && handle.status === "running") {
        handle.abort.abort();
        return true;
      }
    }
    return false;
  }

  /** The rich library result for a run launched this session (AuditRunResult / ConfirmRunResult). */
  resultFor(runId: number): AuditRunResult | ConfirmRunResult | undefined {
    for (const handle of this.runs.values()) if (handle.runId === runId) return handle.result;
    return undefined;
  }

  active(): ActiveRun[] {
    return [...this.runs.values()]
      .filter((handle) => handle.status === "running")
      .map((handle) => ({ runId: handle.runId, target: handle.spec.target, verb: handle.spec.verb, startedAt: handle.startedAt }));
  }

  private reconcile(runId: number, status: RunStatus): void {
    try {
      this.store.finishRun(runId, status);
    } catch {
      // best-effort
    }
  }
}

// Translate a launch spec into `fsa` CLI argv — NOT used to run (the manager runs in-process),
// but handy for showing the equivalent terminal command. Pure and unit-tested.
export function buildArgs(spec: LaunchSpec): string[] {
  const args: string[] = [spec.verb];
  if (spec.verb === "confirm") {
    if (!spec.inputRunDir) throw new Error("confirm requires inputRunDir (the finished run directory)");
    args.push(spec.inputRunDir);
  } else if (spec.verb === "audit" && spec.region) {
    args.push(spec.region);
  }
  args.push("--target", spec.target);
  if (spec.sourcePaths.length > 0) args.push("--source", ...spec.sourcePaths);
  if (spec.buildRoot) args.push("--build-root", spec.buildRoot);
  if (spec.corpusPaths && spec.corpusPaths.length > 0) args.push("--corpus", ...spec.corpusPaths);
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model) args.push("--model", spec.model);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.verb === "audit" && spec.scope) args.push("--scope", spec.scope);
  if (spec.maxScopes !== undefined) args.push("--max-scopes", String(spec.maxScopes));
  if (spec.mapSteps !== undefined) args.push("--map-steps", String(spec.mapSteps));
  if (spec.digSteps !== undefined) args.push("--dig-steps", String(spec.digSteps));
  if (spec.maxSteps !== undefined) args.push("--max-steps", String(spec.maxSteps));
  if (spec.digSamples !== undefined) args.push("--dig-samples", String(spec.digSamples));
  if (spec.digConcurrency !== undefined) args.push("--dig-concurrency", String(spec.digConcurrency));
  if (spec.remap && spec.verb !== "confirm") args.push("--remap");
  if (spec.fresh && spec.verb === "confirm") args.push("--fresh");
  if (spec.quick && spec.verb === "run") args.push("--quick");
  if (spec.mockLlm) args.push("--mock-llm");
  args.push("--out", spec.out ?? DEFAULT_OUT);
  return args;
}

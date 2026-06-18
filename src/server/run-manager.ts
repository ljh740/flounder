// Run-spec utilities shared by the control plane (server) and the execution plane (daemon):
// the translation of a UI/agent LaunchSpec into an AuditorConfig (what the daemon runs) and
// into equivalent `fsa` CLI argv (for display), plus the per-run ActivityBus the server uses
// to fan a daemon's token-level activity out to the UI's live log. Execution itself lives in
// the daemon (src/server/daemon.ts); this module holds no run state.

import { defaultConfig, type AuditorConfig } from "../config.js";
import type { RunKind } from "../db/store.js";

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

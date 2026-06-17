// Run-manager: spawns and supervises `fsa` processes so a UI can launch/continue/restart
// audits across multiple projects concurrently. Each spawned fsa records its own SQLite
// run row (tagged with its OS pid); the manager correlates by pid and reconciles status
// if a process dies before the run reaches `done`. It does not reimplement any audit
// logic — it shells out to the same CLI, and "continue vs restart" map to the kernel's
// existing resume (default) / --remap behavior.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MetadataStore, type RunKind, type RunStatus } from "../db/store.js";

const DEFAULT_OUT = "runs";

export interface LaunchSpec {
  verb: RunKind; // run | map | audit | confirm (verify is an audit selector)
  target: string;
  sourcePaths: string[];
  buildRoot?: string;
  corpusPaths?: string[];
  provider?: string;
  model?: string;
  thinking?: string;
  maxScopes?: number;
  mapSteps?: number;
  digSteps?: number;
  maxSteps?: number;
  digSamples?: number;
  digConcurrency?: number;
  remap?: boolean; // run/map/audit: re-enumerate the scope inventory (restart)
  fresh?: boolean; // confirm: ignore a prior interrupted confirm
  inputRunDir?: string; // confirm: the finished run dir to reproduce (positional)
  region?: string; // audit: a pinned region (positional)
  scope?: string; // audit: --scope id[,id...]
  quick?: boolean; // run: a single breadth pass instead of map -> audit
  mockLlm?: boolean; // run with the deterministic offline model (no provider needed)
  out?: string;
}

export interface ActiveRun {
  pid: number;
  target: string;
  verb: RunKind;
  startedAt: string;
}

/** Translate a launch spec into `fsa` CLI argv. Pure — the unit-tested core of launching. */
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

interface ChildEntry {
  spec: LaunchSpec;
  child: ChildProcess;
  killedByUs: boolean;
  startedAt: string;
  stderr: string[];
}

export class RunManager {
  private readonly cliPath: string;
  private readonly children = new Map<number, ChildEntry>();

  constructor(cliPath?: string) {
    // Resolve the sibling CLI (dist/cli.js) so the manager does not depend on a global install.
    this.cliPath = cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
  }

  /** Spawn an fsa process for the spec. The fsa process records its own DB run row. */
  launch(spec: LaunchSpec): { pid: number; args: string[] } {
    const args = buildArgs(spec);
    const child = spawn(process.execPath, [this.cliPath, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    const pid = child.pid;
    if (pid === undefined) throw new Error("failed to spawn fsa process");
    const entry: ChildEntry = { spec, child, killedByUs: false, startedAt: new Date().toISOString(), stderr: [] };
    this.children.set(pid, entry);
    child.stderr?.on("data", (chunk: Buffer) => {
      entry.stderr.push(chunk.toString());
      if (entry.stderr.length > 50) entry.stderr.splice(0, entry.stderr.length - 50);
    });
    child.on("exit", (code, signal) => {
      this.children.delete(pid);
      // fsa marks a clean run `done` itself; only reconcile an abnormal exit so a UI does
      // not show a dead process as still running.
      const status: RunStatus = entry.killedByUs || signal === "SIGTERM" ? "killed" : code === 0 ? "done" : "error";
      if (status === "done") return;
      try {
        const store = MetadataStore.openForOutput(spec.out ?? DEFAULT_OUT);
        store.reconcileRunByPid(pid, status);
        store.close();
      } catch {
        // reconciliation is best-effort; the run row simply stays `running` if it fails
      }
    });
    return { pid, args };
  }

  /** Continue a project's audit. Resume is the kernel default, so this is just `run` again
   * (it skips MAP and the already-audited scopes, auditing the next batch). */
  continueAudit(spec: Omit<LaunchSpec, "verb" | "remap">): { pid: number; args: string[] } {
    return this.launch({ ...spec, verb: "run" });
  }

  /** Restart a project's audit from scratch (re-enumerate the scope inventory). */
  restartAudit(spec: Omit<LaunchSpec, "verb" | "remap">): { pid: number; args: string[] } {
    return this.launch({ ...spec, verb: "run", remap: true });
  }

  /** Request a graceful stop of a tracked process. Returns false if the pid is not tracked. */
  kill(pid: number): boolean {
    const entry = this.children.get(pid);
    if (!entry) return false;
    entry.killedByUs = true;
    return entry.child.kill("SIGTERM");
  }

  /** Last stderr lines from a tracked process (for surfacing a launch that failed fast). */
  stderrTail(pid: number): string {
    return (this.children.get(pid)?.stderr ?? []).join("");
  }

  active(): ActiveRun[] {
    return [...this.children.entries()].map(([pid, entry]) => ({
      pid,
      target: entry.spec.target,
      verb: entry.spec.verb,
      startedAt: entry.startedAt,
    }));
  }
}

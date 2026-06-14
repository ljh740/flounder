import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { runSandboxCommand, type SandboxWorkspace } from "../security/sandbox.js";
import type { RunLogger } from "../trace/logger.js";
import type { ReproductionCommand } from "../types.js";

// Verification-environment guarantee (not strategy). Confirmation only matters if
// the model's local test can actually compile and run. On a real target that
// means the toolchain's dependencies must be present. This module warms the
// copied workspace ONCE: it detects the toolchain and runs the project's own
// dependency-fetch/build with network allowed and a generous timeout, populating
// the workspace-local caches (CARGO_HOME, GOMODCACHE, npm cache, …) that
// runSandboxCommand already points inside the workspace. Afterwards the model's
// bash test runs are incremental and can run offline and reproducibly.
//
// These commands are framework-chosen and trusted (not model input), so they do
// not pass through the agent bash allowlist. They do execute the target's own
// dependency build scripts in the isolated workspace (HOME and caches already
// point inside it); that is inherent to preparing a real toolchain and is why the
// step is gated by AuditorConfig.huntPrepare.

const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "target", "build", "dist", "coverage", "runs", "__pycache__", ".cache", ".next", ".nuxt", ".turbo"]);
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 8000;

type Toolchain = "cargo" | "go" | "npm" | "pnpm" | "yarn" | "forge";

export interface PrepareCommandResult {
  toolchain: Toolchain;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  ok: boolean;
}

export interface PrepareReport {
  ran: boolean;
  detected: Toolchain[];
  results: PrepareCommandResult[];
}

export async function prepareWorkspaceToolchain(input: { workspace: SandboxWorkspace; cfg: AuditorConfig; logger: RunLogger; cacheDir?: string }): Promise<PrepareReport> {
  const plans = await detectToolchains(input.workspace.absolute);
  if (plans.length === 0) {
    await input.logger.event("hunt_prepare_skipped", { reason: "no supported toolchain manifest detected" });
    return { ran: false, detected: [], results: [] };
  }

  await input.logger.event("hunt_prepare_start", { toolchains: plans.map((plan) => plan.toolchain), timeoutMs: input.cfg.huntPrepareTimeoutMs });
  const results: PrepareCommandResult[] = [];
  for (const plan of plans) {
    for (const argv of plan.commands) {
      const command: ReproductionCommand = {
        program: argv[0] ?? "",
        args: argv.slice(1),
        timeoutMs: input.cfg.huntPrepareTimeoutMs,
        expectedExitCode: 0,
        ...(plan.cwd ? { cwd: plan.cwd } : {}),
      };
      const run = await runSandboxCommand(command, input.workspace.absolute, input.cfg.reproductionMaxLogBytes, input.cfg.sourcePaths, input.cacheDir);
      const ok = run.exitCode === 0 && !run.timedOut;
      const record: PrepareCommandResult = {
        toolchain: plan.toolchain,
        command: argv.join(" "),
        cwd: plan.cwd ?? ".",
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        ok,
      };
      results.push(record);
      await input.logger.event("hunt_prepare_command", { toolchain: plan.toolchain, command: record.command, cwd: record.cwd, exitCode: run.exitCode, timedOut: run.timedOut, ok });
      // If dependency fetch fails or times out, later commands for the same
      // toolchain will too; stop this toolchain but keep warming the others.
      if (!ok) break;
    }
  }

  await input.logger.artifact("hunt_prepare.json", { detected: plans.map((plan) => plan.toolchain), results });
  return { ran: true, detected: plans.map((plan) => plan.toolchain), results };
}

interface ToolchainPlan {
  toolchain: Toolchain;
  cwd?: string;
  commands: string[][];
}

async function detectToolchains(workspaceAbsolute: string): Promise<ToolchainPlan[]> {
  const manifests = await scanManifests(workspaceAbsolute);
  const plans: ToolchainPlan[] = [];
  const shallowest = (predicate: (name: string) => boolean): string | undefined => {
    const dirs = manifests.filter((entry) => predicate(entry.name)).map((entry) => entry.dir);
    if (dirs.length === 0) return undefined;
    return dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  };
  const has = (name: string): boolean => manifests.some((entry) => entry.name === name);

  // Order matters: dependency-install toolchains (npm/pnpm/yarn) run FIRST, because
  // a Solidity/Foundry project often imports its dependencies (e.g. @openzeppelin)
  // from node_modules — so `forge build` only resolves after `npm install`. Then go
  // mod download, then the compile toolchains (cargo, forge).
  const pkgDir = shallowest((name) => name === "package.json");
  if (pkgDir !== undefined) {
    if (has("pnpm-lock.yaml")) plans.push({ toolchain: "pnpm", ...cwd(pkgDir), commands: [["pnpm", "install", "--frozen-lockfile"]] });
    else if (has("yarn.lock")) plans.push({ toolchain: "yarn", ...cwd(pkgDir), commands: [["yarn", "install", "--frozen-lockfile"]] });
    else if (has("package-lock.json")) plans.push({ toolchain: "npm", ...cwd(pkgDir), commands: [["npm", "install", "--no-audit", "--no-fund"]] });
    else plans.push({ toolchain: "npm", ...cwd(pkgDir), commands: [["npm", "install", "--no-audit", "--no-fund"]] });
  }

  const goDir = shallowest((name) => name === "go.mod");
  if (goDir !== undefined) plans.push({ toolchain: "go", ...cwd(goDir), commands: [["go", "mod", "download"]] });

  // Warm with `cargo build` (not `--tests`): it compiles the heavy runtime
  // dependency tree (the bulk of build time, which `cargo test` then reuses)
  // without trying to compile the model's scratch test files under tests/ — those
  // may not compile yet, and a `--tests` warm-up would fail on them and warm nothing.
  const cargoDir = shallowest((name) => name === "Cargo.toml");
  if (cargoDir !== undefined) plans.push({ toolchain: "cargo", ...cwd(cargoDir), commands: [["cargo", "fetch"], ["cargo", "build"]] });

  const foundryDir = shallowest((name) => name === "foundry.toml");
  if (foundryDir !== undefined) plans.push({ toolchain: "forge", ...cwd(foundryDir), commands: [["forge", "build"]] });

  return plans;
}

function cwd(dir: string): { cwd?: string } {
  return dir && dir !== "." ? { cwd: dir } : {};
}

interface ManifestEntry {
  name: string;
  dir: string; // workspace-relative posix dir, "" for root
}

async function scanManifests(root: string): Promise<ManifestEntry[]> {
  const wanted = new Set(["Cargo.toml", "go.mod", "package.json", "foundry.toml", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  const out: ManifestEntry[] = [];
  let budget = MAX_SCAN_ENTRIES;
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || budget <= 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name, depth + 1);
      } else if (wanted.has(entry.name)) {
        out.push({ name: entry.name, dir: relDir });
      }
    }
  };
  await walk(root, "", 0);
  return out;
}

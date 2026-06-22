import type { ConfirmDecision, Coverage, FindingRow, PhaseConfig, ProjectDetail, RunRow, ScopeRow } from "./api";

export const STATUSES = ["confirmed-differential", "confirmed-executable", "confirmed-source", "suspected", "discharged", "refuted"] as const;
export const TRACKING = ["open", "triaging", "submitted", "accepted", "fixed", "duplicate", "rejected"] as const;
export const PHASES = ["prepare", "map", "dig", "confirm"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const PHASE_DESC: Record<(typeof PHASES)[number], string> = {
  prepare: "Stage source and warm the build sandbox",
  map: "Build the scope inventory",
  dig: "Audit mapped scopes and confirm locally",
  confirm: "Reproduce confirmed findings on the real target",
};

const STATUS_RANK: Record<string, number> = {
  "confirmed-differential": 5,
  "confirmed-executable": 4,
  "confirmed-source": 3,
  suspected: 2,
  discharged: 0,
  refuted: -1,
};

const SEV_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export interface PhaseInfo {
  status: string;
  stat: string;
  dur: string;
}

export type PhaseState = Record<(typeof PHASES)[number], PhaseInfo>;

export function rankCandidates(rows: FindingRow[] | undefined): FindingRow[] {
  return [...(rows ?? [])]
    .filter((f) => (STATUS_RANK[f.status] ?? 0) >= 2 && (SEV_RANK[f.severity ?? ""] ?? 0) >= 2)
    .map((f) => ({ f, key: (STATUS_RANK[f.status] ?? 0) * 100 + (SEV_RANK[f.severity ?? ""] ?? 0) * 10 + (Number(f.confidence) || 0) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.f);
}

export function sortScopes(scopes: ScopeRow[]): ScopeRow[] {
  return [...scopes].sort((a, b) => {
    const ga = a.status === "audited" || a.status === "deferred" ? 1 : 0;
    const gb = b.status === "audited" || b.status === "deferred" ? 1 : 0;
    return ga !== gb ? ga - gb : ((b.priority ?? 0) - (a.priority ?? 0)) || ((b.score ?? 0) - (a.score ?? 0));
  });
}

export function confirmedDecisions(rows: ConfirmDecision[] | undefined): ConfirmDecision[] {
  return (rows ?? []).filter((row) => row.reproduced === "yes");
}

export function projectConfig(detail: ProjectDetail | null): { cfg: ProjectConfigShape; sourcePaths: string[]; buildRoot: string; corpusPaths: string[] } {
  if (!detail) return { cfg: {}, sourcePaths: [], buildRoot: "", corpusPaths: [] };
  return {
    cfg: parseJson<ProjectConfigShape>(detail.project.config_json, {}),
    sourcePaths: parseJson<string[]>(detail.project.source_paths, []),
    buildRoot: detail.project.build_root ?? "",
    corpusPaths: parseJson<string[]>(detail.project.corpus_paths, []),
  };
}

export interface ProjectConfigShape {
  scopeCoverageMode?: "focused" | "standard" | "half" | "full" | "custom";
  maxScopes?: number;
  mapSteps?: number;
  digSteps?: number;
  digSamples?: number;
  digConcurrency?: number;
  phases?: PhaseConfig;
  phaseProviders?: Partial<Record<"prepare" | "map" | "dig" | "confirm", number>>;
}

export function parseJson<T>(input: unknown, fallback: T): T {
  if (typeof input !== "string" || !input.trim()) return fallback;
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function fmtTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDur(ms: number): string {
  if (!(ms > 0)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs ? ` ${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function runDur(run: RunRow | undefined, live?: boolean): string {
  if (!run?.started_at) return "";
  const start = new Date(run.started_at).getTime();
  const end = live ? Date.now() : run.ended_at ? new Date(run.ended_at).getTime() : 0;
  return end ? fmtDur(end - start) : "";
}

export function isVerifyRun(run: RunRow | undefined): boolean {
  return Boolean(run && parseJson<{ verify?: boolean }>(run.budgets_json, {}).verify === true);
}

export function runScopeBatchComplete(run: RunRow | undefined): boolean {
  return Boolean(run?.status === "running" && run.run_scopes_target != null && (run.run_scopes_done ?? 0) >= run.run_scopes_target);
}

export function pct(a: number | null | undefined, t: number | null | undefined): number {
  return t && t > 0 ? Math.round(((a ?? 0) / t) * 100) : 0;
}

export function phaseState(detail: ProjectDetail, progress: Coverage): PhaseState {
  const runs = detail.runs ?? [];
  const latest = (...kinds: string[]) => runs.find((r) => kinds.includes(r.kind));
  const prep = latest("prepare");
  const repro = confirmedDecisions(detail.confirmDecisions).length;
  const conf = latest("confirm");
  const pendingConfirm = (detail.allFindings ?? []).filter((finding) => {
    return (finding.status === "confirmed-executable" || finding.status === "confirmed-differential") && !finding.confirm_status;
  }).length;
  const audit = runs.find((r) => r.status === "running" && ["run", "audit", "map"].includes(r.kind));
  const auditLatest = latest("run", "audit", "map");
  const digStarted = Boolean(audit && audit.run_scopes_target != null);
  const mapRunning = Boolean(audit && audit.kind !== "audit" && !digStarted);
  const digRunning = Boolean(audit && (audit.kind === "audit" || digStarted));
  const batchDone = runScopeBatchComplete(audit);
  const finalizingAudit = Boolean(batchDone && audit && !isVerifyRun(audit));
  const thisRun = audit && audit.run_scopes_target != null
    ? batchDone
      ? " · finalizing"
      : ` · current run ${audit.run_scopes_done ?? 0}/${audit.run_scopes_target}`
    : "";
  const isVerify = isVerifyRun(audit);
  const verifyStat = isVerify
    ? `Verifying ${audit?.run_scopes_done ?? 0}/${audit?.run_scopes_target ?? "?"} findings${detail.findingsTotal ? ` · ${detail.findingsTotal} in project` : ""}`
    : "";
  const auditRun = audit ?? auditLatest;
  const startMs = auditRun?.started_at ? new Date(auditRun.started_at).getTime() : 0;
  const endMs = auditLatest?.ended_at ? new Date(auditLatest.ended_at).getTime() : 0;
  const boundMs = auditRun?.dig_started_at ? new Date(auditRun.dig_started_at).getTime() : 0;
  const mapDur = mapRunning ? runDur(audit, true) : progress.total > 0 && startMs && boundMs > startMs ? fmtDur(boundMs - startMs) : "";
  const digDur = digRunning
    ? boundMs
      ? fmtDur(Date.now() - boundMs)
      : runDur(audit, true)
    : progress.audited > 0
      ? boundMs && endMs > boundMs
        ? fmtDur(endMs - boundMs)
        : runDur(auditLatest, false)
      : "";

  return {
    prepare: { status: prep ? prep.status : "none", stat: prep ? (prep.status === "done" ? "Source staged" : prep.status === "running" ? "Preparing source" : prep.status) : "Not started", dur: runDur(prep, prep?.status === "running") },
    map: { status: mapRunning ? "running" : progress.total > 0 ? "done" : "none", stat: progress.total > 0 ? `${progress.total} scopes mapped` : mapRunning ? "Mapping scopes" : "Not started", dur: mapDur },
    dig: {
      status: digRunning ? "running" : progress.audited > 0 ? (progress.pending > 0 ? "partial" : "done") : progress.total > 0 ? "pending" : "none",
      stat: isVerify
        ? verifyStat
        : finalizingAudit
          ? `Verifying candidates · ${progress.audited}/${progress.total} scopes audited${detail.findingsTotal ? ` · ${detail.findingsTotal} in project` : ""}`
          : progress.total > 0
            ? `${progress.audited}/${progress.total} scopes audited · ${progress.pending} pending${detail.findingsTotal ? ` · ${detail.findingsTotal} ${detail.findingsTotal === 1 ? "finding" : "findings"}` : ""}${thisRun}`
            : "Not started",
      dur: digDur,
    },
    confirm: {
      status: conf?.status === "running"
        ? "running"
        : detail.confirmDecisions.length
          ? (repro === detail.confirmDecisions.length && pendingConfirm === 0 ? "done" : "partial")
          : pendingConfirm > 0
            ? "pending"
            : "none",
      stat: detail.confirmDecisions.length
        ? `${repro}/${detail.confirmDecisions.length} reproduced${pendingConfirm ? ` · ${pendingConfirm} waiting` : ""}`
        : pendingConfirm > 0
          ? `${pendingConfirm} waiting for real-target confirmation`
          : "Not started",
      dur: runDur(conf, conf?.status === "running"),
    },
  };
}

export function reportName(kind: string): string {
  if (kind === "confirm") return "confirm_report.md";
  if (kind === "prepare") return "prepare_manifest.json";
  return "audit_report.md";
}

export function runProgress(run: RunRow, decisions: ConfirmDecision[]): string {
  if (run.kind === "confirm") {
    const rows = decisions.filter((d) => d.run_id === run.id);
    return rows.length ? `${rows.filter((d) => d.reproduced === "yes").length}/${rows.length} reproduced` : "No decisions recorded yet";
  }
  if (isVerifyRun(run) && run.run_scopes_target != null) {
    if (runScopeBatchComplete(run)) return `Finalizing verification after ${run.run_scopes_done ?? 0}/${run.run_scopes_target} findings`;
    return `${run.run_scopes_done ?? 0}/${run.run_scopes_target} findings verified`;
  }
  if (run.run_scopes_target != null) {
    if (runScopeBatchComplete(run)) {
      return `Finalizing audit after ${run.run_scopes_done ?? 0}/${run.run_scopes_target} scopes${run.scopes_total != null ? ` · ${run.scopes_audited ?? 0}/${run.scopes_total} total audited` : ""}`;
    }
    return `${run.run_scopes_done ?? 0}/${run.run_scopes_target} scopes in this batch${run.scopes_total != null ? ` · ${run.scopes_audited ?? 0}/${run.scopes_total} total audited` : ""}`;
  }
  if (run.scopes_total != null) return `${run.scopes_audited ?? 0}/${run.scopes_total} scopes audited`;
  return run.findings_total != null ? `${run.findings_total} ${run.findings_total === 1 ? "finding" : "findings"}` : "No progress recorded yet";
}

export function reportFileForFinding(finding: FindingRow): string {
  const name = (finding.report_path ?? "").split("/").pop() ?? "";
  return /^report_f\d+\.md$/.test(name) ? name : "audit_report.md";
}

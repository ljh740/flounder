// SQLite metadata store — the system of record for run TRACKING.
//
// fsa writes here on every run (project, run lifecycle, scope coverage, findings, and
// their status transitions, confirm decisions). The big evidentiary content stays on
// disk (transcripts, PoCs, provenance, the JSON artifacts); the DB stores PATHS to it
// plus the denormalized metadata a UI needs to list/filter/track across all projects.
//
// This is NOT a derived/rebuildable projection — it is written live alongside the run.
// node:sqlite is used so the package stays dependency-free. WAL + a busy timeout let one
// fsa process write while a UI (or other fsa processes) read concurrently.

import "./sqlite-quiet.js"; // must run before node:sqlite loads — filters its experimental warning
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

// A static `import ... from "node:sqlite"` emits the builtin's ExperimentalWarning at link
// time, before sqlite-quiet's body can install the filter. Loading it via require() during
// module evaluation (after the static sqlite-quiet import has run) lets the filter catch it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type RunKind = "run" | "map" | "audit" | "verify" | "confirm";
export type RunStatus = "running" | "done" | "error" | "killed";
export type ScopeStatus = "pending" | "audited";
export type FindingStatus = "suspected" | "confirmed-executable" | "confirmed-differential" | "refuted";

export interface ProjectInput {
  name: string;
  sourcePaths?: string[] | undefined;
  buildRoot?: string | undefined;
  corpusPaths?: string[] | undefined;
  config?: unknown; // model/provider/thinking/budgets/max_scopes snapshot the UI can edit
}

export interface RunInput {
  projectId: number;
  kind: RunKind;
  runDir: string;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  budgets?: unknown;
  pid?: number | undefined;
}

export interface ScopeRow {
  scopeId: string;
  title?: string | undefined;
  location?: string | undefined;
  score?: number | undefined;
  status: ScopeStatus;
}

export interface FindingRow {
  findingKey: string;
  title?: string | undefined;
  location?: string | undefined;
  severity?: string | undefined;
  status: FindingStatus;
  reportPath?: string | undefined;
  scopeId?: string | undefined;
}

export interface ConfirmRow {
  bug: string;
  reproduced?: string | undefined;
  recommendation?: string | undefined;
  members?: string[] | undefined;
  decisionPath?: string | undefined;
}

export interface Coverage {
  total: number;
  audited: number;
  pending: number;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS project(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  source_paths TEXT,
  build_root TEXT,
  corpus_paths TEXT,
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL,
  run_dir TEXT,
  status TEXT NOT NULL,
  pid INTEGER,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  budgets_json TEXT,
  scopes_total INTEGER,
  scopes_audited INTEGER,
  scopes_pending INTEGER,
  findings_total INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_project ON run(project_id);

CREATE TABLE IF NOT EXISTS scope(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  scope_id TEXT NOT NULL,
  title TEXT,
  location TEXT,
  score REAL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_scope_project ON scope(project_id);

CREATE TABLE IF NOT EXISTS finding(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  run_id INTEGER REFERENCES run(id),
  finding_key TEXT NOT NULL,
  title TEXT,
  location TEXT,
  severity TEXT,
  status TEXT NOT NULL,
  report_path TEXT,
  scope_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, finding_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_project ON finding(project_id);

CREATE TABLE IF NOT EXISTS finding_status_event(
  id INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  run_id INTEGER,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fse_finding ON finding_status_event(finding_id);

CREATE TABLE IF NOT EXISTS confirm_decision(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  run_id INTEGER REFERENCES run(id),
  bug TEXT NOT NULL,
  reproduced TEXT,
  recommendation TEXT,
  members_json TEXT,
  decision_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cd_project ON confirm_decision(project_id);
`;

function now(): string {
  return new Date().toISOString();
}

export class MetadataStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL + busy timeout: one writer at a time, concurrent readers, retries instead of
    // SQLITE_BUSY when several fsa processes (multi-project) write the shared DB.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING").run(String(SCHEMA_VERSION));
  }

  /** Open the store for a config's output root (DB lives at <outputDir>/fsa.db). */
  static openForOutput(outputDir: string): MetadataStore {
    return new MetadataStore(path.join(outputDir, "fsa.db"));
  }

  close(): void {
    this.db.close();
  }

  // --- projects -------------------------------------------------------------

  /** Upsert a project by name; refreshes its materials + config snapshot. Returns its id. */
  upsertProject(input: ProjectInput): number {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO project(name, source_paths, build_root, corpus_paths, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           source_paths = excluded.source_paths,
           build_root   = excluded.build_root,
           corpus_paths = excluded.corpus_paths,
           config_json  = excluded.config_json,
           updated_at   = excluded.updated_at`,
      )
      .run(
        input.name,
        jsonOrNull(input.sourcePaths),
        input.buildRoot ?? null,
        jsonOrNull(input.corpusPaths),
        jsonOrNull(input.config),
        ts,
        ts,
      );
    const row = this.db.prepare("SELECT id FROM project WHERE name = ?").get(input.name) as { id: number };
    return row.id;
  }

  listProjects(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM project ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
  }

  // --- runs -----------------------------------------------------------------

  /** Record the start of a run (status=running). Returns the run id. */
  startRun(input: RunInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO run(project_id, kind, run_dir, status, pid, provider, model, thinking, budgets_json, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.kind,
        input.runDir,
        input.pid ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.thinking ?? null,
        jsonOrNull(input.budgets),
        now(),
      );
    return Number(info.lastInsertRowid);
  }

  finishRun(runId: number, status: RunStatus, coverage?: Coverage, findingsTotal?: number): void {
    this.db
      .prepare(
        `UPDATE run SET status = ?, ended_at = ?, scopes_total = ?, scopes_audited = ?, scopes_pending = ?, findings_total = ?
         WHERE id = ?`,
      )
      .run(
        status,
        now(),
        coverage?.total ?? null,
        coverage?.audited ?? null,
        coverage?.pending ?? null,
        findingsTotal ?? null,
        runId,
      );
  }

  setRunPid(runId: number, pid: number): void {
    this.db.prepare("UPDATE run SET pid = ? WHERE id = ?").run(pid, runId);
  }

  /** Mark a still-running run for this OS pid as ended (a supervisor saw the process exit
   * without the run reaching `done`). No-op if it already finished. Returns rows changed. */
  reconcileRunByPid(pid: number, status: RunStatus): number {
    const info = this.db
      .prepare("UPDATE run SET status = ?, ended_at = ? WHERE pid = ? AND status = 'running'")
      .run(status, now(), pid);
    return Number(info.changes);
  }

  /** Live coverage update mid-run (so a UI shows mapped/audited progress as digs land). */
  updateRunCoverage(runId: number, coverage: Coverage): void {
    this.db
      .prepare("UPDATE run SET scopes_total = ?, scopes_audited = ?, scopes_pending = ? WHERE id = ?")
      .run(coverage.total, coverage.audited, coverage.pending, runId);
  }

  listRuns(projectId?: number): Array<Record<string, unknown>> {
    return projectId === undefined
      ? (this.db.prepare("SELECT * FROM run ORDER BY started_at DESC").all() as Array<Record<string, unknown>>)
      : (this.db.prepare("SELECT * FROM run WHERE project_id = ? ORDER BY started_at DESC").all(projectId) as Array<Record<string, unknown>>);
  }

  // --- scopes ---------------------------------------------------------------

  /** Upsert the project's scope inventory (id, title, location, score, status). */
  upsertScopes(projectId: number, scopes: ScopeRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO scope(project_id, scope_id, title, location, score, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, scope_id) DO UPDATE SET
         title = excluded.title, location = excluded.location, score = excluded.score,
         status = excluded.status, updated_at = excluded.updated_at`,
    );
    const ts = now();
    this.transaction(() => {
      for (const s of scopes) {
        stmt.run(projectId, s.scopeId, s.title ?? null, s.location ?? null, s.score ?? null, s.status, ts);
      }
    });
  }

  scopeProgress(projectId: number): Coverage {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'audited' THEN 1 ELSE 0 END) AS audited FROM scope WHERE project_id = ?`,
      )
      .get(projectId) as { total: number; audited: number | null };
    const total = row.total ?? 0;
    const audited = row.audited ?? 0;
    return { total, audited, pending: total - audited };
  }

  // --- findings + status transitions ---------------------------------------

  /**
   * Upsert findings for a run. When a finding's status changes (or it is new), records a
   * row in finding_status_event so the UI can show the suspect→confirm→refute timeline.
   */
  upsertFindings(projectId: number, runId: number, findings: FindingRow[], reason?: string): void {
    this.transaction(() => {
      for (const f of findings) {
        const existing = this.db
          .prepare("SELECT id, status FROM finding WHERE run_id = ? AND finding_key = ?")
          .get(runId, f.findingKey) as { id: number; status: string } | undefined;
        const ts = now();
        if (!existing) {
          const info = this.db
            .prepare(
              `INSERT INTO finding(project_id, run_id, finding_key, title, location, severity, status, report_path, scope_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(projectId, runId, f.findingKey, f.title ?? null, f.location ?? null, f.severity ?? null, f.status, f.reportPath ?? null, f.scopeId ?? null, ts, ts);
          this.recordStatusEvent(Number(info.lastInsertRowid), null, f.status, reason, runId, ts);
        } else {
          this.db
            .prepare(
              `UPDATE finding SET title = ?, location = ?, severity = ?, status = ?, report_path = ?, scope_id = ?, updated_at = ? WHERE id = ?`,
            )
            .run(f.title ?? null, f.location ?? null, f.severity ?? null, f.status, f.reportPath ?? null, f.scopeId ?? null, ts, existing.id);
          if (existing.status !== f.status) {
            this.recordStatusEvent(existing.id, existing.status, f.status, reason, runId, ts);
          }
        }
      }
    });
  }

  private recordStatusEvent(findingId: number, from: string | null, to: string, reason: string | undefined, runId: number, ts: string): void {
    this.db
      .prepare("INSERT INTO finding_status_event(finding_id, from_status, to_status, reason, run_id, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(findingId, from, to, reason ?? null, runId, ts);
  }

  listFindings(projectId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<Record<string, unknown>>;
  }

  findingTimeline(findingId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding_status_event WHERE finding_id = ? ORDER BY ts ASC").all(findingId) as Array<Record<string, unknown>>;
  }

  // --- confirm decisions ----------------------------------------------------

  upsertConfirmDecisions(projectId: number, runId: number, rows: ConfirmRow[], decisionPath?: string): void {
    this.transaction(() => {
      // a confirm run's decision sheet is rewritten wholesale, so replace its rows
      this.db.prepare("DELETE FROM confirm_decision WHERE run_id = ?").run(runId);
      const stmt = this.db.prepare(
        `INSERT INTO confirm_decision(project_id, run_id, bug, reproduced, recommendation, members_json, decision_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ts = now();
      for (const r of rows) {
        stmt.run(projectId, runId, r.bug, r.reproduced ?? null, r.recommendation ?? null, jsonOrNull(r.members), r.decisionPath ?? decisionPath ?? null, ts);
      }
    });
  }

  listConfirmDecisions(projectId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM confirm_decision WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Array<Record<string, unknown>>;
  }

  // --- internals ------------------------------------------------------------

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

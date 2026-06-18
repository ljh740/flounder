// Local web app + REST API for tracking/driving audits across projects. Every workflow
// resource (project, run, scope, finding, confirm decision) is a REST resource, and every
// operation the UI performs is an API call — so an AI agent can drive the whole workflow
// without the UI by fetching GET /api (a self-describing catalog of all endpoints) and
// calling them. The UI is just one client of this API. Zero-dependency: Node's built-in
// http + a vanilla SPA. Binds to localhost only (it can spawn audit processes).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetadataStore, type RunKind, type ScopeStatus } from "../db/store.js";
import { RunManager, type LaunchSpec, type ActivityBus } from "./run-manager.js";
import { projectHistoryDir } from "../trace/history.js";
import { loadScopeInventory, saveScopeInventory } from "../agent/scope-store.js";

const UI_HTML_PATH = fileURLToPath(new URL("./public/index.html", import.meta.url));
function loadUiHtml(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf8");
  } catch {
    return "<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;padding:2rem'>fsa UI asset missing — run <code>npm run build</code>.</body>";
  }
}

export interface UiServerOptions {
  out?: string;
  port?: number;
  host?: string;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  store: MetadataStore;
  manager: RunManager;
  out: string;
}

interface Route {
  method: string;
  path: string; // template, e.g. /api/projects/:name/runs
  summary: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, string>;
  handler: (c: Ctx) => Promise<void> | void;
  hidden?: boolean; // omit from the catalog (the UI page + the catalog itself)
  regex: RegExp;
  paramNames: string[];
}

function route(def: Omit<Route, "regex" | "paramNames">): Route {
  const paramNames: string[] = [];
  const regex = new RegExp(
    "^" +
      def.path.replace(/:[A-Za-z0-9_]+/g, (m) => {
        paramNames.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  return { ...def, regex, paramNames };
}

// ---- the API surface (data-driven, so GET /api can describe it) -----------------------

const ROUTES: Route[] = [
  route({ method: "GET", path: "/", summary: "The web dashboard (HTML).", hidden: true, handler: (c) => { c.res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); c.res.end(loadUiHtml()); } }),
  route({ method: "GET", path: "/api", summary: "This catalog: every resource and operation, so an agent can self-learn and drive the workflow without the UI.", handler: (c) => sendJson(c.res, 200, catalog()) }),

  route({
    method: "GET", path: "/api/projects",
    summary: "List all projects with a live snapshot (scope coverage, finding counts, confirmed-bug count, latest run, active runs).",
    handler: (c) => sendJson(c.res, 200, { projects: projectSnapshots(c.store, c.manager) }),
  }),
  route({
    method: "POST", path: "/api/projects",
    summary: "Create a project (no run starts). Rejects a duplicate name.",
    body: { name: "string (required, unique)", sourcePaths: "string[] — code to audit", buildRoot: "string? — buildable root", corpusPaths: "string[]? — specs/docs", config: "object? — { provider, model, thinking, maxScopes, mapSteps, digSteps, digSamples, digConcurrency }" },
    handler: projectCreate,
  }),
  route({
    method: "GET", path: "/api/projects/:name",
    summary: "Project detail: config, scope coverage, finding/run/confirmed counts, recent runs, confirm decisions.",
    params: { name: "project name" },
    handler: projectGet,
  }),
  route({
    method: "PATCH", path: "/api/projects/:name",
    summary: "Update a project's materials and/or config (no run starts). Used by Continue/Restart/Run afterwards.",
    params: { name: "project name" },
    body: { sourcePaths: "string[]?", buildRoot: "string?", corpusPaths: "string[]?", config: "object?" },
    handler: projectUpdate,
  }),
  route({
    method: "DELETE", path: "/api/projects/:name",
    summary: "Delete a project and everything under it (runs, scopes, findings, confirm decisions). On-disk run artifacts are left untouched.",
    params: { name: "project name" },
    handler: projectDelete,
  }),

  route({
    method: "GET", path: "/api/projects/:name/runs",
    summary: "List a project's runs (newest first).",
    params: { name: "project name" }, query: { limit: "number? — cap rows" },
    handler: (c) => withProject(c, (id) => sendJson(c.res, 200, { runs: c.store.listRuns(id, clampInt(c.url.searchParams.get("limit"), 200, 1, 1000)) })),
  }),
  route({
    method: "POST", path: "/api/projects/:name/runs",
    summary: "Launch a run on the project (start/continue an audit, restart, map, audit a region/scope, or confirm). Uses the project's stored materials + config unless overridden. This is the single action behind the UI's Start/Continue/Restart/Run buttons.",
    params: { name: "project name" },
    body: {
      verb: "'run' | 'map' | 'audit' | 'confirm' (default 'run'; run = map→dig, resumes)",
      remap: "boolean? — re-enumerate scopes (restart)", fresh: "boolean? — confirm: ignore a prior interrupted confirm",
      quick: "boolean? — run: single breadth pass", mockLlm: "boolean? — offline mock model",
      region: "string? — audit: pinned region e.g. src/Foo.sol:120-180", scope: "string? — audit: scope id(s)",
      inputRunDir: "string? — confirm: the finished run dir to reproduce",
      overrides: "object? — { sourcePaths, buildRoot, corpusPaths, config } one-off overrides of the stored project",
    },
    handler: runLaunch,
  }),
  route({
    method: "GET", path: "/api/projects/:name/scopes",
    summary: "List the project's scope inventory (audited / pending / deferred) — the map output.",
    params: { name: "project name" },
    handler: (c) => withProject(c, (id) => sendJson(c.res, 200, { scopes: c.store.listScopes(id), progress: c.store.scopeProgress(id) })),
  }),
  route({
    method: "PATCH", path: "/api/projects/:name/scopes/:scopeId",
    summary: "Set a scope's status — mark it `deferred` to skip it in auto-dig (or `pending` to resume). Updates the persisted inventory the audit reads, so the next run honors it.",
    params: { name: "project name", scopeId: "scope id from the inventory" },
    body: { status: "'deferred' (skip) | 'pending' (resume) | 'audited'" },
    handler: scopeSetStatus,
  }),
  route({
    method: "GET", path: "/api/projects/:name/findings",
    summary: "List findings, paginated + filterable, each with its status timeline (suspect→confirm→refute).",
    params: { name: "project name" },
    query: { status: "string? — exact status filter", q: "string? — text search (title/location)", limit: "number? (default 50)", offset: "number? (default 0)" },
    handler: findingsList,
  }),
  route({
    method: "GET", path: "/api/projects/:name/confirm-decisions",
    summary: "List confirm decisions (one per distinct bug). Filter ?reproduced=yes for the bugs actually reproduced on the real target (the audit's payoff).",
    params: { name: "project name" }, query: { reproduced: "string? — e.g. 'yes' for confirmed bugs" },
    handler: confirmDecisionsList,
  }),

  route({
    method: "GET", path: "/api/runs/:id",
    summary: "A single run (status, kind, coverage, finding count, run dir, timestamps). Includes the rich library `result` (AuditRunResult / ConfirmRunResult — full findings, summary, coverage) for a run launched in the current server session.",
    params: { id: "run id" },
    handler: (c) => {
      const run = c.store.getRun(Number(c.params.id));
      if (!run) return sendJson(c.res, 404, { error: "no such run" });
      const result = c.manager.resultFor(Number(c.params.id));
      sendJson(c.res, 200, { run, ...(result ? { result } : {}) });
    },
  }),
  route({
    method: "POST", path: "/api/runs/:id/stop",
    summary: "Stop a running run (aborts the in-process session). The run is reconciled to 'killed'.",
    params: { id: "run id" },
    handler: runStop,
  }),
  route({
    method: "DELETE", path: "/api/runs/:id",
    summary: "Delete a run and its run-scoped data (findings + status events, confirm decisions). Scopes (the project inventory) and on-disk artifacts are left intact.",
    params: { id: "run id" },
    handler: (c) => { const ok = c.store.deleteRun(Number(c.params.id)); ok ? sendJson(c.res, 200, { ok: true, deleted: Number(c.params.id) }) : sendJson(c.res, 404, { error: "no such run" }); },
  }),
  route({
    method: "GET", path: "/api/runs/:id/log",
    summary: "SSE stream of a run's live activity, tailed from its event log: the model's thinking + output blocks (audit_thinking / audit_text), tool calls (audit_step), and milestones. Streams existing entries then new ones as they happen.",
    params: { id: "run id" },
    handler: runLog,
  }),

  route({ method: "GET", path: "/api/active", summary: "Currently-running processes the run-manager is supervising.", handler: (c) => sendJson(c.res, 200, { active: c.manager.active() }) }),
  route({ method: "GET", path: "/api/stream", summary: "Server-sent events: the project snapshot + active list, pushed ~1/s for live updates.", handler: (c) => streamSnapshots(c.res, c.store, c.manager) }),
];

function catalog(): unknown {
  return {
    name: "full-stack-auditor",
    description: "REST API for tracking and driving white-hat audits. Resources: project (CRUD), run (launch/stop/read), scope, finding, confirm-decision. Every UI operation is one of these calls.",
    resources: ["project", "run", "scope", "finding", "confirm-decision"],
    endpoints: ROUTES.filter((r) => !r.hidden).map((r) => ({
      method: r.method,
      path: r.path,
      summary: r.summary,
      ...(r.params ? { params: r.params } : {}),
      ...(r.query ? { query: r.query } : {}),
      ...(r.body ? { body: r.body } : {}),
    })),
  };
}

export function startUiServer(options: UiServerOptions = {}): ReturnType<typeof createServer> {
  const out = options.out ?? "runs";
  const port = options.port ?? 4500;
  const host = options.host ?? "127.0.0.1"; // localhost only — this endpoint can spawn processes
  const store = MetadataStore.openForOutput(out);
  // Runs execute in this process, so any row left `running` is orphaned by a prior restart.
  const orphans = store.reconcileOrphanedRuns();
  if (orphans > 0) console.log(`[fsa ui] reconciled ${orphans} interrupted run(s) from a previous session`);
  const manager = new RunManager(store, out); // runs the library in-process (not the CLI)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      const match = r.regex.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1] ?? "")));
      Promise.resolve(r.handler({ req, res, params, url, store, manager, out })).catch((error) =>
        sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) }),
      );
      return;
    }
    sendJson(res, 404, { error: "not found", hint: "GET /api lists every endpoint" });
  });
  server.listen(port, host, () => {
    console.log(`[fsa ui] http://${host}:${port}  (API catalog: http://${host}:${port}/api · store: ${out}/fsa.db)`);
  });
  return server;
}

// ---- handlers -------------------------------------------------------------------------

function withProject(c: Ctx, fn: (projectId: number, project: Record<string, unknown>) => void): void {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) {
    sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
    return;
  }
  fn(Number(project.id), project);
}

async function projectCreate(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as { name?: string; sourcePaths?: string[]; buildRoot?: string; corpusPaths?: string[]; config?: unknown };
  const name = (body.name ?? "").trim();
  if (!name) return sendJson(c.res, 400, { error: "project name is required" });
  if (c.store.getProject(name)) return sendJson(c.res, 409, { error: `a project named "${name}" already exists` });
  c.store.upsertProject({ name, sourcePaths: body.sourcePaths, buildRoot: body.buildRoot, corpusPaths: body.corpusPaths, config: body.config });
  sendJson(c.res, 200, { ok: true, name });
}

function projectGet(c: Ctx): void {
  withProject(c, (id, project) => {
    sendJson(c.res, 200, {
      project,
      progress: c.store.scopeProgress(id),
      statusCounts: c.store.findingStatusCounts(id),
      findingsTotal: c.store.countFindings(id),
      confirmedBugs: c.store.countConfirmedBugs(id),
      runs: c.store.listRuns(id, 50),
      runsTotal: c.store.countRuns(id),
      confirmDecisions: c.store.listConfirmDecisions(id),
    });
  });
}

async function projectUpdate(c: Ctx): Promise<void> {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) return sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
  const body = (await readBody(c.req)) as { sourcePaths?: string[]; buildRoot?: string; corpusPaths?: string[]; config?: unknown };
  c.store.upsertProject({ name: String(project.name), sourcePaths: body.sourcePaths, buildRoot: body.buildRoot, corpusPaths: body.corpusPaths, config: body.config });
  sendJson(c.res, 200, { ok: true });
}

function projectDelete(c: Ctx): void {
  const removed = c.store.deleteProject(c.params.name ?? "");
  removed ? sendJson(c.res, 200, { ok: true, deleted: c.params.name }) : sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
}

async function scopeSetStatus(c: Ctx): Promise<void> {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) return sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
  const body = (await readBody(c.req)) as { status?: string };
  const status = body.status;
  if (status !== "pending" && status !== "audited" && status !== "deferred") {
    return sendJson(c.res, 400, { error: "status must be one of pending | audited | deferred" });
  }
  const scopeId = c.params.scopeId ?? "";
  // Update the persisted inventory the AUDIT reads (history-dir scopes.json), so the next
  // dig honors the skip — then mirror it into the UI's SQLite projection.
  const inventoryDir = projectHistoryDir({ outputDir: c.out, targetName: String(project.name) });
  const inventory = await loadScopeInventory(inventoryDir);
  const scope = inventory.find((s) => s.id === scopeId);
  if (!scope) return sendJson(c.res, 404, { error: `no scope "${scopeId}" in the inventory` });
  scope.status = status;
  await saveScopeInventory(inventoryDir, inventory);
  c.store.setScopeStatus(Number(project.id), scopeId, status);
  sendJson(c.res, 200, { ok: true, scopeId, status });
}

async function runLaunch(c: Ctx): Promise<void> {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) return sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const result = c.manager.launch(launchSpec(project, body, c.out));
  sendJson(c.res, 200, result);
}

function findingsList(c: Ctx): void {
  withProject(c, (id) => {
    const status = c.url.searchParams.get("status") ?? undefined;
    const search = c.url.searchParams.get("q") ?? undefined;
    const limit = clampInt(c.url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
    const findings = c.store.queryFindings(id, { status, search, limit, offset }).map((finding) => ({ ...finding, timeline: c.store.findingTimeline(Number(finding.id)) }));
    sendJson(c.res, 200, { findings, total: c.store.countFindings(id, { status, search }), limit, offset });
  });
}

function confirmDecisionsList(c: Ctx): void {
  withProject(c, (id) => {
    const reproduced = c.url.searchParams.get("reproduced");
    let rows = c.store.listConfirmDecisions(id);
    if (reproduced) rows = rows.filter((row) => row.reproduced === reproduced);
    sendJson(c.res, 200, { confirmDecisions: rows });
  });
}

function runStop(c: Ctx): void {
  const id = Number(c.params.id);
  if (!c.store.getRun(id)) return sendJson(c.res, 404, { error: "no such run" });
  sendJson(c.res, 200, { stopped: c.manager.stop(id) });
}

function runLog(c: Ctx): void {
  const id = Number(c.params.id);
  const run = c.store.getRun(id);
  if (!run) return sendJson(c.res, 404, { error: "no such run" });
  // A run launched this session streams token-level activity from the in-memory bus; any
  // other run (e.g. historical, or after a restart) tails its persisted event log.
  const bus = c.manager.activityFor(id);
  if (bus) {
    streamFromBus(c.res, bus);
    return;
  }
  if (typeof run.run_dir === "string") {
    streamRunLog(c.res, run.run_dir);
    return;
  }
  sendJson(c.res, 404, { error: "run has no activity or event log" });
}

function streamFromBus(res: ServerResponse, bus: ActivityBus): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const unsubscribe = bus.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  res.on("close", unsubscribe);
}

// Tail a run's events.jsonl over SSE: send existing lines, then poll for appended bytes and
// stream new ones. The run process (separate from this server) appends the model's thinking/
// output blocks + tool calls there, so this is the live-activity channel for the UI.
function streamRunLog(res: ServerResponse, runDir: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const file = path.join(runDir, "events.jsonl");
  let offset = 0;
  let buf = "";
  const pump = (): void => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return; // not created yet
    }
    if (size < offset) {
      offset = 0;
      buf = "";
    }
    if (size <= offset) return;
    const start = offset;
    offset = size;
    const stream = createReadStream(file, { start, end: size - 1, encoding: "utf8" });
    let chunk = "";
    stream.on("data", (d) => {
      chunk += d;
    });
    stream.on("end", () => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) res.write(`data: ${line}\n\n`);
    });
    stream.on("error", () => {});
  };
  pump();
  const timer = setInterval(pump, 700);
  res.on("close", () => clearInterval(timer));
}

// ---- shared -----------------------------------------------------------------

function projectSnapshots(store: MetadataStore, manager: RunManager): Array<Record<string, unknown>> {
  const activeByTarget = new Map<string, number>();
  for (const run of manager.active()) activeByTarget.set(run.target, (activeByTarget.get(run.target) ?? 0) + 1);
  return store.listProjects().map((project) => {
    const id = Number(project.id);
    return {
      name: project.name,
      config: safeParse(project.config_json),
      progress: store.scopeProgress(id),
      findingCounts: store.findingStatusCounts(id),
      findingsTotal: store.countFindings(id),
      confirmedBugs: store.countConfirmedBugs(id),
      runCount: store.countRuns(id),
      latestRun: store.latestRun(id) ?? null,
      activeRuns: activeByTarget.get(String(project.name)) ?? 0,
    };
  });
}

function streamSnapshots(res: ServerResponse, store: MetadataStore, manager: RunManager): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const tick = (): void => {
    res.write(`data: ${JSON.stringify({ projects: projectSnapshots(store, manager), active: manager.active() })}\n\n`);
  };
  tick();
  const timer = setInterval(tick, 1200);
  res.on("close", () => clearInterval(timer));
}

// Build a launch spec from the project's stored materials/config + the request body
// (verb + run-shape flags + optional one-off overrides). Unbounded (null) budgets stay
// undefined so the kernel's unbounded default applies.
function launchSpec(project: Record<string, unknown>, body: Record<string, unknown>, out: string): LaunchSpec {
  const cfg = (safeParse(project.config_json) as Record<string, unknown>) ?? {};
  const overrides = (body.overrides as Record<string, unknown>) ?? {};
  const merged = { ...cfg, ...((overrides.config as Record<string, unknown>) ?? {}) };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const list = (v: unknown, fallback: unknown): string[] => {
    const arr = Array.isArray(v) ? v : (safeParse(fallback) as unknown[]) ?? [];
    return arr.filter((x): x is string => typeof x === "string");
  };
  return {
    verb: (typeof body.verb === "string" ? body.verb : "run") as RunKind,
    target: String(project.name),
    sourcePaths: list(overrides.sourcePaths, project.source_paths),
    buildRoot: str(overrides.buildRoot) ?? str(project.build_root),
    corpusPaths: list(overrides.corpusPaths, project.corpus_paths),
    provider: str(merged.provider),
    model: str(merged.model),
    thinking: str(merged.thinking),
    maxScopes: num(merged.maxScopes),
    mapSteps: num(merged.mapSteps),
    digSteps: num(merged.digSteps),
    maxSteps: num(merged.maxSteps),
    digSamples: num(merged.digSamples),
    digConcurrency: num(merged.digConcurrency),
    remap: Boolean(body.remap),
    fresh: Boolean(body.fresh),
    quick: Boolean(body.quick),
    mockLlm: Boolean(body.mockLlm),
    region: str(body.region),
    scope: str(body.scope),
    inputRunDir: str(body.inputRunDir),
    out,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function safeParse(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

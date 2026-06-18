import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../dist/server/app.js";
import { MetadataStore } from "../dist/db/store.js";

// Execution is decoupled: the server owns the DB + a job queue and never runs an audit;
// a daemon claims queued jobs, runs them elsewhere, and reports progress over HTTP. These
// drive the server as BOTH the UI client (public API) and a simulated daemon (the hidden
// /api/daemon/* protocol), pinning the whole handoff without spawning a real audit.

async function withServerAndToken(fn) {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-daemon-"));
  // Mint a daemon token directly in the store (the server has no token-minting endpoint;
  // `fsa ui` mints one for its co-located daemon, an operator mints them for remote ones).
  const minting = MetadataStore.openForOutput(out);
  const { token } = minting.createDaemonToken("test-daemon");
  minting.close();

  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, token, out });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const j = (r) => r.json();
const ui = (base, method, p, body) => fetch(base + p, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const asDaemon = (base, token, method, p, body) =>
  fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("daemon: register requires a valid bearer token", async () => {
  await withServerAndToken(async ({ base, token }) => {
    assert.equal((await fetch(base + "/api/daemon/register", { method: "POST" })).status, 401); // no token
    assert.equal((await asDaemon(base, "deadbeef", "POST", "/api/daemon/register")).status, 401); // wrong token
    const ok = await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1", capabilities: {} });
    assert.equal(ok.status, 200);
    assert.equal((await j(ok)).ok, true);
    // claim/run/activity/status all reject an unknown token too
    assert.equal((await fetch(base + "/api/daemon/claim", { method: "POST" })).status, 401);
  });
});

test("daemon: full job handoff — enqueue → claim → run start → ingest → finish", async () => {
  await withServerAndToken(async ({ base, token }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });

    // UI creates a project and queues a run.
    await ui(base, "POST", "/api/projects", { name: "acme", sourcePaths: ["./src"], config: { model: "m" } });
    const launch = await j(await ui(base, "POST", "/api/projects/acme/runs", { verb: "run", mockLlm: true }));
    assert.equal(launch.queued, true);
    assert.equal(typeof launch.jobId, "number");

    // Daemon claims the oldest queued job (FIFO), then opens a run row for it.
    const claim = await j(await asDaemon(base, token, "POST", "/api/daemon/claim"));
    assert.equal(claim.job.id, launch.jobId);
    assert.equal(claim.job.project, "acme");
    assert.equal(claim.job.spec.verb, "run");
    assert.equal((await asDaemon(base, token, "POST", "/api/daemon/claim").then(j)).job, undefined); // queue drained

    const start = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId: launch.jobId, project: "acme", kind: "run", runDir: "/tmp/acme-run-1", budgets: { model: "m" } }));
    assert.equal(typeof start.runId, "number");
    const runId = start.runId;
    // job ↔ run is linked (so a stop-by-run can find the job).
    assert.equal((await j(await ui(base, "GET", `/api/runs/${runId}`))).run.status, "running");

    // Daemon reports the scope inventory; the run's live coverage updates.
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { scopes: [{ scopeId: "s1", title: "decode", status: "audited" }, { scopeId: "s2", title: "settle", status: "pending" }] });
    const afterScopes = await j(await ui(base, "GET", "/api/projects/acme"));
    assert.deepEqual(afterScopes.progress, { total: 2, audited: 1, pending: 1, deferred: 0 });

    // Daemon reports findings (with a status reason for the timeline) and a confirm decision.
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { findings: [{ findingKey: "f1", title: "unbound input", location: "src/x:10", status: "suspected" }], reason: "first sighting" });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { findings: [{ findingKey: "f1", title: "unbound input", location: "src/x:10", status: "confirmed-differential" }], reason: "differential passed" });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { confirmDecisions: [{ bug: "unbound input", reproduced: "yes", recommendation: "submit-candidate" }], decisionPath: "/tmp/acme-run-1/confirm_report.md" });

    const findings = await j(await ui(base, "GET", "/api/projects/acme/findings"));
    assert.equal(findings.findings.length, 1);
    assert.equal(findings.findings[0].status, "confirmed-differential");
    assert.deepEqual(findings.findings[0].timeline.map((e) => e.to_status), ["suspected", "confirmed-differential"]);
    const detail = await j(await ui(base, "GET", "/api/projects/acme"));
    assert.equal(detail.confirmedBugs, 1); // reproduced=yes surfaced as a confirmed bug

    // Daemon finishes the run; status + final coverage/finding-count persist.
    await asDaemon(base, token, "POST", `/api/daemon/jobs/${launch.jobId}/status`, { status: "done" });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { finish: { status: "done", coverage: { total: 2, audited: 2, pending: 0, deferred: 0 }, findingsTotal: 1 } });
    const finished = await j(await ui(base, "GET", `/api/runs/${runId}`));
    assert.equal(finished.run.status, "done");
    assert.equal(finished.run.findings_total, 1);
  });
});

test("daemon: activity POSTs surface on the run's live SSE log", async () => {
  await withServerAndToken(async ({ base, token }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });
    await ui(base, "POST", "/api/projects", { name: "p" });
    const { jobId } = await j(await ui(base, "POST", "/api/projects/p/runs", { verb: "run", mockLlm: true }));
    await asDaemon(base, token, "POST", "/api/daemon/claim");
    const { runId } = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId, project: "p", kind: "run", runDir: "/tmp/p-1", budgets: {} }));

    // Daemon pushes a batch of token-level activity (as the live audit would).
    await asDaemon(base, token, "POST", `/api/daemon/runs/${runId}/activity`, { events: [{ kind: "thinking_delta", delta: "weighing the invariant" }, { kind: "step", tool: "bash", step: 1 }] });

    // The public log stream replays the backlogged events (this is the daemon → bus → SSE pipe).
    const ev = await readFirstActivity(base, runId, 2500);
    assert.ok(ev, "expected an activity event on the SSE log");
    assert.equal(ev.kind, "thinking_delta");
    assert.equal(ev.delta, "weighing the invariant");
  });
});

test("daemon: stopping a run flags its job for cancel and reconciles on the daemon's report", async () => {
  await withServerAndToken(async ({ base, token, out }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });
    await ui(base, "POST", "/api/projects", { name: "p" });
    const { jobId } = await j(await ui(base, "POST", "/api/projects/p/runs", { verb: "run", mockLlm: true }));
    await asDaemon(base, token, "POST", "/api/daemon/claim");
    const { runId } = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId, project: "p", kind: "run", runDir: "/tmp/p-1", budgets: {} }));

    // UI stops the run → the job is flagged for cancel (a connected daemon would get an SSE nudge).
    const stop = await j(await ui(base, "POST", `/api/runs/${runId}/stop`));
    assert.equal(stop.stopped, true);
    const store = MetadataStore.openForOutput(out);
    try {
      assert.deepEqual(store.canceledJobIds(), [jobId]); // the daemon polls/streams this to abort
    } finally {
      store.close();
    }

    // Daemon reports the job canceled; the still-running run is reconciled to killed.
    await asDaemon(base, token, "POST", `/api/daemon/jobs/${jobId}/status`, { status: "canceled" });
    assert.equal((await j(await ui(base, "GET", `/api/runs/${runId}`))).run.status, "killed");
  });
});

// Open the SSE log, return the first activity event (one with a `kind`), then abort. The
// event is already in the bus backlog, so the first read returns it — no hang.
async function readFirstActivity(base, runId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/runs/${runId}/log`, { signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev && ev.kind) {
            controller.abort();
            return ev;
          }
        } catch {
          // skip a non-JSON frame (e.g. the ": open" comment)
        }
      }
    }
  } catch {
    // aborted at the timeout
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}

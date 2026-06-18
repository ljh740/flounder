import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../dist/server/app.js";

// The whole workflow is a REST API an agent can self-learn (GET /api) and drive without
// the UI. This pins the catalog + a project CRUD round-trip over real HTTP.

async function withServer(fn) {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-api-"));
  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("api: GET /api is a self-describing catalog of every resource + operation", async () => {
  await withServer(async (base) => {
    const cat = await (await fetch(base + "/api")).json();
    assert.deepEqual(cat.resources, ["project", "run", "scope", "finding", "confirm-decision"]);
    const sigs = cat.endpoints.map((e) => e.method + " " + e.path);
    for (const expected of [
      "GET /api/projects", "POST /api/projects", "GET /api/projects/:name",
      "PATCH /api/projects/:name", "DELETE /api/projects/:name",
      "POST /api/projects/:name/runs", "GET /api/projects/:name/findings",
      "GET /api/projects/:name/scopes", "GET /api/projects/:name/confirm-decisions",
      "GET /api/runs/:id", "POST /api/runs/:id/stop",
    ]) assert.ok(sigs.includes(expected), `catalog missing ${expected}`);
    // every endpoint documents a summary so an agent can learn it
    assert.ok(cat.endpoints.every((e) => typeof e.summary === "string" && e.summary.length > 0));
  });
});

test("api: project CRUD round-trip over HTTP", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    assert.deepEqual((await json(await fetch(base + "/api/projects"))).projects, []);

    assert.equal((await json(await post("/api/projects", { name: "p", sourcePaths: ["./s"], config: { model: "gpt-5.5" } }))).ok, true);
    assert.equal((await post("/api/projects", { name: "p" })).status, 409); // duplicate rejected

    const detail = await json(await fetch(base + "/api/projects/p"));
    assert.equal(detail.project.name, "p");
    assert.equal(detail.findingsTotal, 0);
    assert.deepEqual(detail.progress, { total: 0, audited: 0, pending: 0, deferred: 0 });

    await fetch(base + "/api/projects/p", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { model: "opus" } }) });
    assert.equal(JSON.parse((await json(await fetch(base + "/api/projects/p"))).project.config_json).model, "opus");

    assert.deepEqual((await json(await fetch(base + "/api/projects/p/findings"))).findings, []);
    assert.equal((await fetch(base + "/api/projects/p", { method: "DELETE" })).status, 200);
    assert.equal((await fetch(base + "/api/projects/p")).status, 404);
  });
});

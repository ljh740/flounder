import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { enumerateAuditItems } from "../dist/enumerate.js";

test("initial enumeration reserves item budget for later rounds and keeps source diversity", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "budget-test";
  cfg.maxAuditItems = 7;
  cfg.rounds = 2;
  cfg.maxNewItemsPerRound = 3;

  const artifacts = new Map();
  const events = [];
  const logger = {
    async artifact(name, value) {
      artifacts.set(name, value);
      return name;
    },
    async event(kind, data) {
      events.push({ kind, data });
    },
  };
  const llm = {
    async complete(input) {
      assert.equal(input.tag, "enumerate");
      return JSON.stringify([
        raw("add-1", "chip/add.rs:10"),
        raw("add-2", "chip/add.rs:20"),
        raw("add-3", "chip/add.rs:30"),
        raw("add-incomplete", "chip/add_incomplete.rs:10"),
        raw("mul-complete", "chip/mul/complete.rs:10"),
        raw("mul-incomplete", "chip/mul/incomplete.rs:10"),
      ]);
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source: [
      { path: "chip/add.rs", content: "fn add() {}", kind: "source" },
      { path: "chip/add_incomplete.rs", content: "fn add_incomplete() {}", kind: "source" },
      { path: "chip/mul/complete.rs", content: "fn mul_complete() {}", kind: "source" },
      { path: "chip/mul/incomplete.rs", content: "fn mul_incomplete() {}", kind: "source" },
    ],
    llm,
    logger,
    round: 1,
  });

  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((entry) => entry.id),
    ["add-1", "add-incomplete", "mul-complete", "mul-incomplete"],
  );
  assert.deepEqual(artifacts.get("checklist.json").map((entry) => entry.id), items.map((entry) => entry.id));

  const limited = events.find((event) => event.kind === "enumeration_limited");
  assert.ok(limited);
  assert.equal(limited.data.maxAuditItems, 7);
  assert.equal(limited.data.roundOneBudget, 4);
  assert.equal(limited.data.reservedForLaterRounds, 3);
  assert.equal(limited.data.before, 6);
  assert.equal(limited.data.after, 4);
});

function raw(id, location) {
  return {
    id,
    location,
    securityProperty: `${id} security property`,
    failureMode: "missing_constraint",
    why: `${id} rationale`,
  };
}

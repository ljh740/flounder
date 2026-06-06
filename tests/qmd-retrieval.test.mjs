import assert from "node:assert/strict";
import test from "node:test";
import { parseQmdHits, qmdArgsForQuery } from "../dist/retrieval/qmd.js";

test("qmd parser accepts common JSON result shapes", () => {
  const hits = parseQmdHits(
    JSON.stringify({
      results: [
        {
          displayPath: "src/auth.ts",
          score: 0.91,
          lineNumber: 42,
          title: "Auth flow",
          snippet: "tenant authorization check",
        },
        {
          document: { path: "src/billing.ts" },
          rerank_score: "0.73",
          from_line: "88",
        },
      ],
    }),
  );

  assert.deepEqual(hits, [
    {
      path: "src/auth.ts",
      score: 0.91,
      line: 42,
      title: "Auth flow",
      snippet: "tenant authorization check",
    },
    {
      path: "src/billing.ts",
      score: 0.73,
      line: 88,
    },
  ]);
});

test("qmd parser ignores invalid or pathless rows", () => {
  assert.deepEqual(parseQmdHits("not json"), []);
  assert.deepEqual(parseQmdHits(JSON.stringify([{ score: 1 }, { path: "src/app.ts" }])), [{ path: "src/app.ts" }]);
});

test("qmd parser tolerates progress text around JSON output", () => {
  const hits = parseQmdHits(`Expanding query...\nSearching 4 queries...\n${JSON.stringify([{ file: "src/proof.rs", score: 0.8 }])}\n`);
  assert.deepEqual(hits, [{ path: "src/proof.rs", score: 0.8 }]);
});

test("qmd query args include optional collection filters", () => {
  assert.deepEqual(qmdArgsForQuery("find assignment ingress", { limit: 5, minScore: 0.25, collections: ["target-code", "target-docs", "target-code"] }), [
    "query",
    "find assignment ingress",
    "--format",
    "json",
    "-n",
    "5",
    "--min-score",
    "0.25",
    "-c",
    "target-code",
    "-c",
    "target-docs",
  ]);
});

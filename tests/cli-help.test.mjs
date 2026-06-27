import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("cli help lists verify alias and project report regeneration", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "--help"], { cwd: root });
  assert.match(stdout, /flounder verify\s+<file> --source <paths\.\.\.>/);
  assert.match(stdout, /flounder report\s+--project <uuid\|name> \[--finding <id>\.\.\.\] \[--all\]/);
  assert.match(stdout, /flounder continue\s+--project <uuid\|name>/);
  assert.match(stdout, /Without --finding\/--all,\s+report generates only missing reports/);
  assert.match(stdout, /same as the UI Continue button/);
});

test("cli continue has command-specific help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "continue", "--help"], { cwd: root });
  assert.match(stdout, /flounder continue --project <uuid\|name>/);
  assert.match(stdout, /verb:"run"/);
  assert.match(stdout, /--coverage <mode>/);
});

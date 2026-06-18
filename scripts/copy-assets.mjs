#!/usr/bin/env node
// Copy non-TS runtime assets (the web UI's static files) into dist after tsc, which only
// emits .js. Keeps the SPA as a real .html/.css/.js asset rather than a string in TS.
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const src = path.resolve("src/server/public");
const dest = path.resolve("dist/server/public");

await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-assets] ${src} -> ${dest}`);

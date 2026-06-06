import { mkdir, writeFile, appendFile, readdir } from "node:fs/promises";
import path from "node:path";

export class RunLogger {
  readonly runDir: string;
  readonly callsDir: string;
  readonly eventsPath: string;
  readonly streamEvents: boolean;
  #callSeq = 0;

  constructor(baseDir: string, targetName: string, now = new Date(), options: { runDir?: string; streamEvents?: boolean } = {}) {
    const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    this.runDir = options.runDir ? path.resolve(options.runDir) : path.join(baseDir, `${targetName}-${ts}`);
    this.callsDir = path.join(this.runDir, "calls");
    this.eventsPath = path.join(this.runDir, "events.jsonl");
    this.streamEvents = options.streamEvents ?? false;
  }

  async init(): Promise<void> {
    await mkdir(this.callsDir, { recursive: true });
    this.#callSeq = await maxExistingCallSeq(this.callsDir);
  }

  async event(kind: string, data: Record<string, unknown> = {}): Promise<void> {
    const rec = { ts: new Date().toISOString(), kind, ...data };
    await appendFile(this.eventsPath, `${JSON.stringify(rec)}\n`);
    if (this.streamEvents) {
      process.stderr.write(`${formatEventLine(kind, data)}\n`);
    }
  }

  async call(input: {
    tag: string;
    model: string;
    system: string;
    user: string;
    response: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    this.#callSeq += 1;
    const file = path.join(this.callsDir, `${String(this.#callSeq).padStart(4, "0")}_${safeName(input.tag)}.json`);
    const publicFile = toPosix(path.relative(this.runDir, file));
    await writeFile(
      file,
      JSON.stringify(
        {
          seq: this.#callSeq,
          tag: input.tag,
          model: input.model,
          system: input.system,
          user: input.user,
          response: input.response,
          meta: input.meta ?? {},
        },
        null,
        2,
      ),
    );
    await this.event("model_call", {
      tag: input.tag,
      model: input.model,
      call: publicFile,
      charsIn: input.system.length + input.user.length,
      charsOut: input.response.length,
    });
  }

  async artifact(name: string, value: unknown): Promise<string> {
    const file = path.join(this.runDir, name);
    const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    await writeFile(file, body);
    await this.event("artifact", { name, path: toPosix(name) });
    return file;
  }
}

function formatEventLine(kind: string, data: Record<string, unknown>): string {
  const details = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .slice(0, 10)
    .map(([key, value]) => `${key}=${formatEventValue(value)}`)
    .join(" ");
  return details ? `[fsa] ${kind} ${details}` : `[fsa] ${kind}`;
}

function formatEventValue(value: unknown): string {
  if (typeof value === "string") return quoteCompact(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return quoteCompact(`[${value.map((item) => formatShort(item)).join(",")}]`);
  if (value && typeof value === "object") return quoteCompact(JSON.stringify(value));
  if (value === null) return "null";
  return quoteCompact(String(value));
}

function formatShort(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function quoteCompact(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const truncated = compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  return JSON.stringify(truncated);
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}

async function maxExistingCallSeq(callsDir: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(callsDir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue;
    const rawSeq = match[1];
    if (!rawSeq) continue;
    const seq = Number.parseInt(rawSeq, 10);
    if (Number.isFinite(seq)) max = Math.max(max, seq);
  }
  return max;
}

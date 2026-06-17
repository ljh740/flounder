# fsa command reference

Complete flag, provider, budget, output, and pi-tool reference for `fsa`. The [SKILL.md](../SKILL.md) overview and workflow come first; read this when you need exact flags or behavior.

## Contents

- [Verbs](#verbs)
- [Sealed vs open-world](#sealed-vs-open-world)
- [Materials options](#materials-options)
- [Model and provider options](#model-and-provider-options)
- [Budgets and coverage (run / map / audit)](#budgets-and-coverage-run--map--audit)
- [audit selectors](#audit-selectors)
- [confirm options](#confirm-options)
- [pi tools (fsa_run / fsa_confirm)](#pi-tools-fsa_run--fsa_confirm)
- [Providers and auth](#providers-and-auth)
- [Outputs (artifacts)](#outputs-artifacts)
- [Confirmation ladder](#confirmation-ladder)

## Verbs

| Verb | What it does |
|---|---|
| `fsa run --target <name> --source <paths...>` | Sealed audit: **map → deep-audit** in one pass. `--quick` makes it a single breadth pass instead. The default real audit. |
| `fsa map --target <name> --source <paths...>` | Enumerate + persist the scope inventory only (writes `audit_scopes.json`), no dig. Inspect/curate scopes before auditing. |
| `fsa audit [<region> \| --scope <id,...> \| --verify <file>] --source <paths...>` | Deep-audit a pinned region, specific inventory scopes, or confirm-or-refute given claims. With no selector, digs the existing inventory. |
| `fsa confirm <run-dir> --source <paths...>` | Open-world: reproduce a finished run's findings on the real target and emit a decision sheet. |
| `fsa history import-run --target <name> --run <dir>` | Import an external run directory into the target's durable history. |

## Sealed vs open-world

`run` / `map` / `audit` are **network-sealed**: the model finds and proves bugs blind, with no network access (provably no online lookup). `confirm` is the **open-world** counterpart: it freezes a prior run's findings, then *with* the network reproduces each against real ground truth (e.g. a mainnet fork), consolidates duplicates, checks novelty, and emits a submit/no-submit decision sheet.

## Materials options

| Flag | Meaning |
|---|---|
| `--source <paths...>` | Code under audit; the model reads (not modifies) these. Point at a buildable root (or use `--build-root`) to enable execution confirmation. |
| `--build-root <dir>` | Directory copied into the sandbox so the target compiles (e.g. a workspace root); defaults to `--source`. A buildable target is what separates `confirmed` from `suspected`. |
| `--corpus <paths...>` | Design/reference **materials** the model reads to derive what the code MUST enforce: real specs, whitepapers, design notes, prior audits, or a strictly factual incident brief. Context, not answers — never the bug, its location, or its mechanism; do not author it yourself. |
| `--target <name>` | Run/artifact name and durable-memory key. |
| `--config <file>` | JSON config with project context, models, and paths. Optional and off by default; only seeds a known vulnerability class. CLI flags override it. |
| `--scope-note <text>` | One-line authorized-scope hint surfaced to the agent. |

## Model and provider options

| Flag | Meaning |
|---|---|
| `--provider <name>` | pi-ai provider. Default `openai-codex` (a pi-session provider). `codex-cli` / `claude-code` are CLI fallbacks. |
| `--model <name>` | Set the audit model. |
| `--thinking <level>` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. |
| `--out <dir>` | Artifact output directory (default `runs`). |
| `--history-dir <dir>` | Project history directory (default `<out>/history`). |
| `--mock-llm` | Use the deterministic mock model (offline; cannot fork a network — discovery smoke test only). |
| `--no-prepare` | Skip the toolchain warm-up (deps fetch/build). |
| `--prepare-timeout-ms <n>` | Per-command timeout for the warm-up (default 600000). |
| `--no-refute` / `--no-appeal` | Skip the independent-refutation / one-appeal passes on confirmed findings. |

## Budgets and coverage (run / map / audit)

Budgets are **UNBOUNDED by default** — a run ends when the model emits done, not at a step count. A fixed budget silently truncates a productive dig, so cap a phase only when you mean to.

| Flag | Meaning |
|---|---|
| `--quick` | `run` only: a single breadth pass instead of map → audit. |
| `--max-steps <n>` | Cap agent turns for a breadth pass / pinned audit (default UNBOUNDED). |
| `--map-steps <n>` | Cap the map phase (default UNBOUNDED). |
| `--dig-steps <n>` | Cap each scope's dig (default UNBOUNDED; the dig stops when its obligations are discharged). |
| `--dig-samples <n>` | Independent dig passes per scope, findings unioned (raises recall). Default 1. |
| `--dig-concurrency <n>` | Scopes deep-audited in parallel, each in an isolated workspace. Default 1. |
| `--max-scopes <n>` | Un-audited scopes the dig audits per run. Default 10. |
| `--remap` | Re-enumerate scopes from scratch (default resumes the persisted inventory). |

**Resume.** The scope inventory persists with per-scope status. A map → dig run audits the highest-scored not-yet-audited scopes up to `--max-scopes`; the rest stay `pending`. Re-running `fsa run` (or `fsa audit` against the inventory) skips MAP and audits the next batch. The inventory is checkpointed right after MAP and after each dig, so a run killed mid-way also resumes — redoing only the one in-flight dig.

## audit selectors

Choose one; default digs the existing inventory.

| Selector | Meaning |
|---|---|
| `<region>` | Deep-audit one pinned region, e.g. `src/Foo.sol:120-180` (no map needed). |
| `--scope <id[,id...]>` | Deep-audit specific scope id(s) from the inventory (run `fsa map` first). |
| `--verify <file>` | Confirm-or-refute given suspected finding(s) by execution. `<file>` is JSON — one finding or an array; each: `title`, `location`, `description`, `exploit_sketch?`, `fix_patch?`. Writes a PoC, builds, and runs it through the confirmation gate + differential, marking each `confirmed-differential` / `confirmed-executable` / `REFUTED`. Needs a buildable target. |

## confirm options

`fsa confirm <run-dir> --source <paths...>` — `<run-dir>` is a finished `fsa run` directory (it must contain `audit_findings.json` with confirmed findings).

| Flag | Meaning |
|---|---|
| `--source <paths...>` | The target code to reproduce against (required). `--build-root` recommended for buildable reproduction. |
| `--max-steps <n>` | Cap turns. **Unbounded by default** (reproduction is heavy; ends when the model is done). |
| `--fresh` | Ignore a prior interrupted confirm of the same run and start over. Default: **auto-resume**, carrying already-settled rows forward and reproducing only the rest. |

Confirm **requires** a pi-session provider (e.g. `openai-codex`); it cannot run on the mock/CLI fallbacks because it forks a live network.

## pi tools (fsa_run / fsa_confirm)

When fsa is loaded as a pi extension (`pi -e full-stack-auditor`), it registers two tools that mirror the verbs. The narrower postures (`map`, `audit <region>/--scope/--verify`, `history`) stay CLI-only.

**`fsa_run`** — sealed map→dig audit. Parameters: `target`, `sourcePaths`, `corpusPaths?`, `provider?`, `model?`, `maxSteps?` (default unbounded; when set, caps each phase), `scopeNote?`, `outputDir?`, `historyDir?`.

**`fsa_confirm`** — open-world reproduction of a finished run. Parameters: `target`, `runDir`, `sourcePaths`, `buildRoot?`, `corpusPaths?`, `provider?` (must be a pi-session provider), `model?`, `maxSteps?` (default unbounded), `fresh?` (default auto-resume), `outputDir?`, `historyDir?`.

## Providers and auth

- Default provider is `openai-codex`, a pi-session provider that runs a continuous agent session. It needs a one-time interactive `pi` `/login` before headless runs work.
- `fsa confirm` and the `fsa_confirm` tool require a pi-session provider — the mock and plain CLI fallbacks cannot fork a live network.
- `--mock-llm` runs the deterministic offline model: useful only as a discovery smoke test, never for confirm.

## Outputs (artifacts)

Each `fsa run` writes (under `<out>/<target>-<timestamp>/`):

- `audit_findings.json` — raw agent-reported findings with confirmation status.
- `audit_scopes.json` — the scored scope inventory (also produced by `fsa map`).
- `audit_report.md` — consolidated results (findings, hypotheses, scope coverage).
- `summary.json` — ranked finding summary and coverage.
- `audit_transcript.json`, `events.jsonl`, `calls/*.json` — replayable trace and model-call records.
- `<out>/history/<target>/memory.jsonl` — durable per-target memory across runs.

Each `fsa confirm` writes (under `<out>/<target>-confirm-<timestamp>/`):

- `confirm_provenance.json` — sha256 + timestamp of the run findings, frozen before any network access.
- `confirm_decision.json` — the decision sheet: one row per distinct bug (reproduced?, evidence, novelty, recommendation).
- `confirm_report.md` — the human-readable decision sheet.
- `confirm_equivalence.json` — the fix-equivalence matrix (which fixes block which PoCs) and the resulting clusters.

Run artifacts are private by default — redact before sharing outside the trusted project context.

## Confirmation ladder

- `suspected` — a candidate without a passing cited local test. Not submittable.
- `confirmed-executable` — the agent cited a `purpose=confirm` `bash` record that actually passed. The framework checks the recorded result; the model cannot upgrade a finding by assertion.
- `confirmed-differential` — the model's fix, applied to pristine source, blocks the exploit (and the original PoC still fails against the fix).

An independent refutation skeptic re-judges every confirmation; a vacuous PoC is downgraded and flagged, with one appeal allowed. "Looks standard" / "matches upstream" never clears a finding — only the security property and its execution do.

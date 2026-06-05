# Architecture

## Boundary

`full-stack-auditor` has two layers:

- Audit engine: deterministic TypeScript modules under `src/ingest`, `src/index`, `src/profile`, `src/lens`, `src/seeders`, `src/audit`, `src/verify`, and `src/reports`.
- Pi integration: thin adapters under `src/llm/pi-ai.ts` and `src/pi/extension.ts`.
- Optional local fallback: `src/llm/codex-cli.ts` for authenticated Codex CLI environments when pi provider credentials are unavailable.

The audit engine should not depend on pi-coding-agent. This keeps batch runs, CI, web UI, RPC mode, and future coding-agent flows on the same underlying artifacts.

## Pipeline

```mermaid
flowchart TD
  subgraph Entry["Entry Points"]
    CLI["CLI: fsa run"]
    PI["pi extension: fsa_run_audit"]
    LIB["Library API: runPipeline"]
  end

  subgraph Inputs["Authorized Inputs"]
    SRC["Source files and directories"]
    CORPUS["Specs, docs, papers, references"]
    CFG["Project context, lens packs, custom agents"]
  end

  subgraph Engine["Audit Engine"]
    INGEST["Ingest and path sanitization"]
    INDEX["SourceIndex and structural retrieval"]
    PROFILE["Deterministic project profile"]
    LENS["Model reconnaissance and dynamic lens packs"]
    ENUM["Model checklist enumeration"]
    ROUND1["Round 1 checklist"]
    AUDIT1["Specialized audit trials"]
    DEEPEN["Round 2+ deepening agent"]
    DELTA["Novel checklist delta"]
    AUDITN["Audit trials for new items"]
    AGG["Aggregation and ranking"]
    VERIFY["Skeptical local-only verification"]
    REPORT["Private disclosure drafts"]
  end

  subgraph Providers["Model Providers"]
    PIAI["pi-ai providers"]
    CODEX["codex-cli fallback"]
    MOCK["Mock LLM for CI"]
  end

  subgraph Safety["Safety and Hygiene"]
    POLICY["Command safety policy"]
    PUBLIC["Public-surface scan"]
    TRACE["Events, calls, and artifacts"]
  end

  CLI --> INGEST
  PI --> INGEST
  LIB --> INGEST
  SRC --> INGEST
  CORPUS --> INGEST
  CFG --> PROFILE
  CFG --> LENS
  CFG --> ENUM
  INGEST --> INDEX
  INGEST --> PROFILE
  INDEX --> LENS
  PROFILE --> LENS
  LENS --> ENUM
  INDEX --> ENUM
  ENUM --> ROUND1
  ROUND1 --> AUDIT1
  AUDIT1 --> AGG
  AUDIT1 --> DEEPEN
  DEEPEN --> DELTA
  DELTA --> AUDITN
  AUDITN --> AGG
  AGG --> VERIFY
  VERIFY --> REPORT
  PIAI -. default .-> LENS
  PIAI -. default .-> ENUM
  PIAI -. default .-> AUDIT1
  PIAI -. default .-> DEEPEN
  PIAI -. default .-> VERIFY
  CODEX -. explicit fallback .-> LENS
  CODEX -. explicit fallback .-> ENUM
  CODEX -. explicit fallback .-> AUDIT1
  CODEX -. explicit fallback .-> DEEPEN
  CODEX -. explicit fallback .-> VERIFY
  MOCK -. tests .-> LENS
  MOCK -. tests .-> ENUM
  MOCK -. tests .-> AUDIT1
  PI --> POLICY
  REPORT --> TRACE
  AGG --> TRACE
  VERIFY --> TRACE
  PUBLIC --> TRACE
```

```text
source + corpus
  -> ingest
  -> source index / retrieval
  -> deterministic project profile
  -> model project reconnaissance / dynamic lens packs
  -> local checklist seeders
  -> LLM enumeration
  -> round 1 checklist
  -> specialized audit trials
  -> round 2+ model deepening / novel checklist delta
  -> specialized audit trials for new items
  -> aggregation
  -> independent verification plan
  -> disclosure draft
```

Project profile, source index, dynamic lens packs, and local checklist seeders are planning and context mechanisms. They may propose audit questions and routing guidance, but they must not produce bug findings. Findings come only from model-backed audit trials.

`AuditorConfig.localChecklistSeeders` controls whether deterministic seeders contribute checklist items. Normal exploratory runs can keep them enabled for coverage hints. Blind proof runs should disable them so both checklist enumeration and audit findings come from model calls.

## Rounds vs Trials

The framework has two different repetition mechanisms:

- `rounds`: project exploration depth. Round 1 creates the initial checklist. Round 2 and later call a deepening agent that reads prior checklist coverage, audit observations, and ranked findings, then proposes only novel follow-up items.
- `trials`: per-item stochastic coverage. Each trial audits the same item independently so aggregation can use hit rate and confidence instead of trusting one sample.

This distinction is important. A stronger run should not merely repeat the same checklist. Later rounds must add new `(location, security property, failure mode)` coverage, and the pipeline rejects duplicates using the same normalized item key for all rounds. If a deepening round produces no new items, the run records the no-op and stops instead of replaying prior items.

The deepening stage is still a planning stage. It does not produce findings. It only expands the checklist with source-grounded questions for later audit agents.

## Agent Roles

- LensDiscoveryAgent: reads the loaded project context and proposes dynamic lens packs for the target's assets, trust boundaries, invariants, attacker capabilities, and domain-specific failure modes.
- Enumerator: maps code locations, spec statements, security properties, and failure modes.
- DeepeningAgent: reads prior coverage and audit observations, then proposes novel follow-up checklist items for later rounds.
- MissingConstraintAuditor: traces witness values to equality/copy/range constraints.
- BalanceIntegrityAuditor: checks conservation and turnstile boundaries.
- NullifierAuditor: checks uniqueness of spend markers and replay resistance.
- SpecMismatchAuditor: compares implementation and written spec line by line.
- ConsensusAuditor: checks ambiguity that could split implementations.
- VerificationAgent: refutes or confirms findings and writes local-only test scaffolds.

Audit roles are declared in `src/agents/registry.ts`. Adding a new role should be a registry change plus tests and, when useful, a local checklist seeder.

The registry is extensible at runtime. `AuditorConfig.auditorAgents` accepts additional agent definitions, and their failure modes are merged into the enumeration prompt through `effectiveFailureModes`. The audit runner builds an agent registry for each run, so custom checklist items can route to custom guidance without changing built-in agents.

Project-specific customization has two layers:

- `projectContext`: human- or config-provided assets, attacker capabilities, trust boundaries, invariants, focus areas, and out-of-scope notes.
- `lensPacks`: scenario-specific failure modes, enumeration guidance, audit guidance, and optional auditor agents.

Live runs can also enable `dynamicLensDiscovery`, which asks the model to produce additional lens packs before enumeration. These packs are normalized, bounded, written to `lens_packs.json`, and merged into the current run config. They are reviewable planning artifacts, not findings.

## Blind Discovery Gate

`npm run check:blind-discovery` runs the framework against a neutral fixture. The fixture does not name a target protocol, impact, or expected bug. The gate passes only if local checklist generation produces a generic missing-constraint audit item from source structure alone.

This is not a substitute for model discovery. Local checklist seeders prepare coverage; only model-backed audit trials count as autonomous bug-discovery evidence.

## Pi Integration

The project is a pi package. `package.json` exposes:

- `src/pi/extension.ts` as an extension with audit tools.
- `skills/whitehat-auditor/SKILL.md` as operating instructions.
- `prompts/audit-target.md` as a reusable prompt template.

The extension registers read-only audit tools first. Tools that write tests or run commands should stay behind explicit user confirmation and sandbox guards.

`fsa_run_audit` defaults to dry-run so package users can inspect checklist generation before spending model calls. The extension also installs a guardrail on bash tool calls and direct user bash commands that combine public live networks with exploit/broadcast wording.

The command guardrail lives in `src/security/policy.ts` so non-pi integrations can reuse and test the same policy.

Model calls should use pi-ai providers by default. `provider=codex-cli` is an explicit local fallback for validation runs and should not replace pi package integration.

## Runnable Gates

- `npm run check`: strict TypeScript compile.
- `npm test`: build plus Node tests for JSON parsing, seeders, dry-run pipeline, mock end-to-end pipeline, and pi extension registration.
- `npm run dry-run`: local checklist seeder run against fixtures. It must produce zero findings.
- `npm run mock-run`: full model-shaped pipeline using deterministic mock LLM.
- `npm run check:blind-discovery`: blind fixture regression for checklist enumeration.
- `npm run check:source-discovery -- --source <path>`: opt-in live model assertion that disables local checklist seeders by default, requires an enumeration model call, requires audit model calls, and requires a model-produced finding without committing that source.

Use `--rounds <n>` with the source-discovery gate when evaluating iterative deepening. Round artifacts must show that later coverage came from `deepen_round_<n>` model calls and survived duplicate filtering.

Use `--expect-location-line <n>` with `--expect-location-file-regex <regex>` when the oracle should accept a broader model-produced source range that contains the target line. Use `--run-dir <path>` to re-check an existing live run artifact without making new model calls.

## Local-Only Verification

Verification code must default to a local-only ladder:

1. Unit test against the isolated gadget/function.
2. Component test against the local protocol implementation.
3. End-to-end local regtest/devnet/forked-node test.

It must not generate or run live-network exploitation flows.

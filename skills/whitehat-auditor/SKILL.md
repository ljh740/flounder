---
name: whitehat-auditor
description: Drives security audits with the full-stack-auditor (fsa) framework — an autonomous, execution-grounded auditor where the model investigates source with read/write/edit/bash tools and proves bugs with local tests. Use when auditing source code for security vulnerabilities (smart contracts, ZK/proof-system circuits, protocols, consensus, cryptography, or application/infrastructure code), when reproducing or refuting a suspected bug against a real target such as a mainnet fork, or when deciding whether a finding is worth disclosing. Covers the sealed `fsa run` discovery pass (found blind, no network), the open-world `fsa confirm` reproduction pass, and the `fsa_run` / `fsa_confirm` pi tools.
---

# Security auditing with full-stack-auditor (fsa)

`fsa` is an autonomous, execution-grounded security auditor. The **model** drives the investigation: it reads source, writes and runs local tests with `read`/`write`/`edit`/`bash` tools, and proves bugs by execution. The framework supplies capability and a confirmation gate — **not** a checklist and **not** bug answers. A finding is real because a local test ran, never because code "looks wrong" or "matches upstream".

Two passes, used in order:

- **`fsa run` — sealed discovery.** Runs with no network access, so a finding is provably *found blind*, not looked up. The model maps the attack surface, deep-audits it scope by scope, and confirms bugs with local tests.
- **`fsa confirm` — open-world reproduction.** Takes a finished run's findings and reproduces each against **real ground truth** (e.g. a mainnet fork of the deployed contract), consolidates duplicates into distinct bugs, checks novelty online, and emits a submit/no-submit decision sheet.

> Found blind (`run`), then reproduced open (`confirm`).

## When to use

- Auditing source for security bugs: smart contracts, ZK / proof-system circuits, protocols, consensus, cryptography, or application / infrastructure code.
- Reproducing or refuting a suspected vulnerability against the real target.
- Deciding whether a finding is worth disclosing to the project.

## Running fsa

`fsa` ships as the `full-stack-auditor` npm package (it installs an `fsa` binary). Two ways to drive it:

**CLI** (the primary surface):

```bash
npm install -g full-stack-auditor          # or run via: npx full-stack-auditor <verb> ...
fsa run --target <name> --source <code> --corpus <specs> --provider openai-codex
```

The default provider `openai-codex` is a pi-session provider and needs a one-time interactive `pi` `/login`. `fsa confirm` **requires** a pi-session provider (it forks a live network); the mock/CLI fallbacks cannot.

**As pi tools** (when fsa is loaded into another pi agent via `pi -e full-stack-auditor`): call the `fsa_run` and `fsa_confirm` tools. They mirror the `fsa run` / `fsa confirm` verbs, so a pi agent can orchestrate discover→reproduce. Parameters are in [reference/commands.md](reference/commands.md).

## Core workflow

Copy this checklist and track progress:

```
Audit progress:
- [ ] 1. Gather materials: the buildable target source + the project's real specs/docs
- [ ] 2. Discover (sealed): fsa run → findings proven by local tests
- [ ] 3. Triage: keep confirmed-executable / confirmed-differential findings
- [ ] 4. Reproduce (open-world): fsa confirm <run-dir> → decision sheet
- [ ] 5. Decide: submit only submit-candidate rows, each with a faithful PoC
```

**1. Materials.** Point `--source` at the buildable target (or add `--build-root <dir>` for the workspace root — a buildable target is what separates `confirmed` from `suspected`). Point `--corpus` at the project's REAL specs, whitepapers, prior audits, or a strictly factual incident brief. Corpus is context, never the answer: it must not name the bug, its location, or its mechanism, and you must not author it yourself. Give the spec; let the model find the gap.

**2. Discover.** `fsa run --target <name> --source <code> --build-root . --corpus <specs> --provider openai-codex`. This enumerates a scored scope inventory, then deep-audits the top scopes obligation by obligation. It is network-sealed. Budgets are unbounded by default — let a dig finish; a decisive obligation can surface late in its budget. The run is resumable: re-running skips the already-audited scopes.

**3. Triage.** Read `audit_report.md` / `audit_findings.json`. A finding's status is the framework's verdict from execution, not the model's claim (see [Confirmation ladder](#confirmation-ladder)).

**4. Reproduce.** `fsa confirm <run-dir> --source <code> --build-root . --provider openai-codex`. It freezes the findings (pre-network provenance), reproduces each on the real target, consolidates by fix-equivalence, checks novelty, and writes `confirm_report.md`. Unbounded by default; auto-resumes if interrupted.

**5. Decide.** Submit only the rows the decision sheet marks `submit-candidate`, each with an exhibited effect (a drained balance, a forged output, an accepted invalid input) — never an argument.

## White-hat rules (non-negotiable)

- **MUST** audit only code you are authorized to audit, or public bug-bounty scope.
- **`fsa run` is local-only and network-sealed**: unit tests, regtest, devnet, or a forked local node — never any live network.
- **`fsa confirm` may fork and READ a live network, but MUST NEVER broadcast** a transaction to a non-local network, move funds, or write to any live system. Replay the exploit against a *local* fork only.
- Build the PoC the way a real attacker would: assume only attacker-real capabilities; never grant yourself behavior the deployed system would deny.
- Generate the smallest reproduction that proves or refutes the property.
- Prefer private disclosure drafts over public exploit writeups.

## Confirmation ladder

A finding is only as strong as the execution behind it:

- `suspected` — a candidate with no passing local test. Not submittable.
- `confirmed-executable` — a cited `purpose=confirm` local test actually passed.
- `confirmed-differential` — the model's fix, applied to pristine source, blocks the exploit.

An independent skeptic re-judges every confirmation: a **vacuous** PoC — one that only triggers by giving a trusted or pinned component behavior a real attacker cannot cause — is downgraded and flagged (a downgraded finding gets one appeal). "Looks standard" / "matches upstream" never clears a finding; only the property and its execution do.

## Command summary

| Verb | Use |
|---|---|
| `fsa run` | default audit: map → deep-audit in one pass (`--quick` = a single breadth pass) |
| `fsa map` | enumerate the scope inventory only |
| `fsa audit <region>` / `--scope <id,...>` / `--verify <file>` | deep-audit a pinned region, inventory scopes, or confirm-or-refute given claims |
| `fsa confirm <run-dir>` | open-world reproduction + submit/no-submit decision sheet |

- Full flags, providers, budgets, resume, outputs, and pi-tool parameters: **[reference/commands.md](reference/commands.md)**.
- Concrete worked audits (EVM rollup, ZK circuit): **[reference/examples.md](reference/examples.md)**.

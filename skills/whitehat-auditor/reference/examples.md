# fsa worked examples

Two concrete end-to-end audits showing the discover → reproduce flow. Replace paths and target names with your own. See [reference/commands.md](commands.md) for every flag.

## Example 1 — EVM rollup, cold audit then open-world confirm

Audit a deployed Solidity rollup with only the real contracts and the official specs — no hint that any bug exists.

```bash
# 1. Discover (sealed): map the decode/settlement surface, then deep-audit it.
fsa run \
  --target rollup-audit \
  --source ./contracts --build-root . \
  --corpus ./docs/specs \
  --provider openai-codex \
  --map-steps 60 --dig-steps 60 --dig-samples 2
```

The run enumerates a scored scope inventory, deep-audits the top scopes obligation by obligation, and writes findings to `runs/rollup-audit-<timestamp>/`. A real unbound-input bug (e.g. a field not bound to the verifier's public-input hash) can reach `confirmed-differential` here — the model writes the proof-of-malleability PoC, the framework builds and runs it, then applies the model's fix and re-runs to show it blocks the exploit.

```bash
# 2. Reproduce (open-world): take that run to a real-world standard.
fsa confirm runs/rollup-audit-<timestamp> \
  --source ./contracts --build-root . \
  --provider openai-codex
```

Confirm forks mainnet (`forge test --fork-url …`) against the **real deployed contract and its real verifier**, flips one attacker-controllable input, and marks the finding `reproduced` only if the effect is exhibited on-chain. It also execution-*refutes* any finding whose PoC only worked against a mocked component. Read the decision sheet at `confirm_report.md`.

## Example 2 — ZK circuit soundness (stack-agnostic)

Audit a Rust ZK circuit crate for an under-constrained-witness bug.

```bash
# Map enumerates the circuit's constraints (including operands the spec treats as given);
# the dig writes a MockProver malicious-witness test.
fsa run \
  --target circuit-audit \
  --source ./crate --build-root ./workspace \
  --corpus ./docs/circuit-spec \
  --provider openai-codex \
  --dig-samples 2
```

A subtle soundness gap often needs a pinned, repeated dig rather than blind breadth:

```bash
# After a map, deep-audit one suspicious scope several times and union the findings.
fsa map   --target circuit-audit --source ./crate --build-root ./workspace --corpus ./docs/circuit-spec --provider openai-codex
fsa audit --scope <id> --source ./crate --build-root ./workspace --provider openai-codex --dig-samples 3
```

A crate-internal soundness bug can reach `confirmed-differential`: the model writes the exploit witness, the framework runs it through `MockProver`, then applies the model's constraint fix and re-runs to show the malicious witness no longer verifies.

## Confirm-or-refute a specific suspicion

When you already suspect a concrete bug and just want execution to settle it:

```bash
# claims.json: [{ "title": "...", "location": "src/Foo.sol:120", "description": "...",
#                "exploit_sketch": "...", "fix_patch": { ... } }]
fsa audit --verify claims.json --source ./contracts --build-root . --provider openai-codex
```

Each claim comes back `confirmed-differential`, `confirmed-executable`, or `REFUTED` — by execution, not argument.

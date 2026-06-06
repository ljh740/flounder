import type { AuditItem } from "../types.js";

const GENERIC_SECURITY_TERMS = [
  "nullifier",
  "balance",
  "supply",
  "signature",
  "verify",
  "auth",
  "session",
  "tenant",
  "permission",
  "owner",
  "admin",
  "query",
  "sql",
  "fetch",
  "url",
  "path",
  "file",
  "deserialize",
  "external",
  "call",
  "proof",
  "constraint",
];

const CONSTRAINT_SYSTEM_TERMS = [
  "assign_advice",
  "copy_advice",
  "advice",
  "witness",
  "constraint",
  "gate",
  "selector",
  "circuit",
  "proof",
];

const STRUCTURAL_FAILURE_MODE_TERMS = ["constraint", "soundness"];

export function retrievalTermsForItem(item: AuditItem): string[] {
  const text = itemSearchText(item);
  const lowered = text.toLowerCase();
  const raw = lowered
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 4);
  const priority = [...CONSTRAINT_SYSTEM_TERMS, ...GENERIC_SECURITY_TERMS].filter((term) => lowered.includes(term));
  return [...new Set([...priority, ...raw])].slice(0, 24);
}

export function shouldIncludeStructuralContext(item: AuditItem, terms: string[]): boolean {
  const failureMode = item.failureMode.toLowerCase();
  return (
    STRUCTURAL_FAILURE_MODE_TERMS.some((term) => failureMode.includes(term)) ||
    terms.some((term) => CONSTRAINT_SYSTEM_TERMS.includes(term))
  );
}

function itemSearchText(item: AuditItem): string {
  return [
    item.id,
    item.location,
    item.securityProperty,
    item.failureMode,
    item.why,
    ...(item.attackerControlledInputs ?? []),
  ].join(" ");
}

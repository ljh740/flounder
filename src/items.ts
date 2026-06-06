import type { AuditItem } from "./types.js";

export interface RawAuditItem {
  id?: string;
  location?: string;
  securityProperty?: string;
  security_property?: string;
  failureMode?: string;
  failure_mode?: string;
  failureModes?: string[];
  failure_modes?: string[];
  why?: string;
  title?: string;
  auditObjective?: string;
  audit_objective?: string;
  dataflow?: string;
  checks?: string[];
  sourceRefs?: string[];
  source_refs?: string[];
  referenceRefs?: string[];
  reference_refs?: string[];
  specRefs?: string[];
  spec_refs?: string[];
  attackerControlledInputs?: string[];
  attacker_controlled_inputs?: string[];
  strategy?: string;
}

export function normalizeAuditItem(raw: RawAuditItem, round?: number): AuditItem | undefined {
  const location = (raw.location ?? raw.sourceRefs?.join("; ") ?? raw.source_refs?.join("; "))?.trim();
  const securityProperty = (raw.securityProperty ?? raw.security_property ?? raw.auditObjective ?? raw.audit_objective ?? raw.title)?.trim();
  const failureMode = (raw.failureMode ?? raw.failure_mode ?? raw.failureModes?.[0] ?? raw.failure_modes?.[0])?.trim();
  if (!location || !securityProperty || !failureMode) return undefined;
  const why = raw.why?.trim() || portfolioWhy(raw) || "Enumerated by model.";
  const item: AuditItem = {
    id: raw.id?.trim() || slug(`${failureMode}-${location}`),
    location,
    securityProperty,
    failureMode: failureMode as AuditItem["failureMode"],
    why,
  };
  const specRefs = raw.specRefs ?? raw.spec_refs ?? raw.referenceRefs ?? raw.reference_refs;
  const attackerControlledInputs = raw.attackerControlledInputs ?? raw.attacker_controlled_inputs;
  if (specRefs) item.specRefs = specRefs;
  if (attackerControlledInputs) item.attackerControlledInputs = attackerControlledInputs;
  if (round !== undefined) item.round = round;
  if (raw.strategy === "breadth" || raw.strategy === "depth") item.strategy = raw.strategy;
  return item;
}

function portfolioWhy(raw: RawAuditItem): string | undefined {
  const parts = [
    raw.dataflow,
    ...(Array.isArray(raw.checks) && raw.checks.length > 0 ? [`Checks: ${raw.checks.join(" ")}`] : []),
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function dedupeAuditItems(items: AuditItem[]): AuditItem[] {
  const seen = new Set<string>();
  const out: AuditItem[] = [];
  for (const item of items) {
    const key = auditItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.map((item, idx) => ({ ...item, id: item.id || `item-${idx}` }));
}

export function selectDiverseAuditItems(items: AuditItem[], maxItems: number | undefined): AuditItem[] {
  if (typeof maxItems !== "number" || !Number.isFinite(maxItems) || maxItems < 1) return items;
  const limit = Math.floor(maxItems);
  if (items.length <= limit) return items;

  const buckets = new Map<string, AuditItem[]>();
  const bucketOrder: string[] = [];
  for (const item of items) {
    const bucket = auditItemDiversityBucket(item);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
      bucketOrder.push(bucket);
    }
    buckets.get(bucket)?.push(item);
  }

  const out: AuditItem[] = [];
  while (out.length < limit && buckets.size > 0) {
    for (const bucket of [...bucketOrder]) {
      const queued = buckets.get(bucket);
      if (!queued) continue;
      const next = queued.shift();
      if (next) out.push(next);
      if (queued.length === 0) buckets.delete(bucket);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function auditItemKey(item: Pick<AuditItem, "location" | "failureMode" | "securityProperty">): string {
  return [item.location, item.failureMode, item.securityProperty].map(canonicalText).join("|");
}

export function auditItemDiversityBucket(item: Pick<AuditItem, "location">): string {
  const firstLocation = item.location.split(/[;,]/)[0]?.trim() ?? item.location;
  return firstLocation.replace(/:\d+(?:-\d+)?(?:\s*)$/, "").trim() || "unknown";
}

function canonicalText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

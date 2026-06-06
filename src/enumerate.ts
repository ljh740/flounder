import type { AuditorConfig } from "./config.js";
import { effectiveFailureModes } from "./config.js";
import { buildEnumerationPrompt, buildPortfolioEnumerationPrompt, ENUM_SYSTEM } from "./agents/prompts.js";
import { buildEnumerationContext } from "./enumeration/context.js";
import { SourceIndex } from "./index/source-index.js";
import { renderProjectLearning } from "./learn/project.js";
import { renderLensPacks, renderProjectContext } from "./lens/context.js";
import { renderProofObligations } from "./obligations/extract.js";
import { renderProjectProfile } from "./profile/project.js";
import { renderProvenanceGraph } from "./provenance/halo2.js";
import { runSeeders } from "./seeders/index.js";
import type { AuditItem, Doc, LlmClient, ProjectLearning, ProjectProfile, ProofObligation, ProvenanceGraph } from "./types.js";
import { extractJsonArray } from "./util/json.js";
import type { RunLogger } from "./trace/logger.js";
import { dedupeAuditItems, normalizeAuditItem, selectDiverseAuditItems, type RawAuditItem } from "./items.js";

export async function enumerateAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  sourceIndex?: SourceIndex;
  projectProfile?: ProjectProfile;
  projectLearning?: ProjectLearning;
  proofObligations?: ProofObligation[];
  provenanceGraphs?: ProvenanceGraph[];
  llm?: LlmClient;
  logger: RunLogger;
  round?: number;
}): Promise<AuditItem[]> {
  const round = input.round ?? 1;
  const seeded = input.cfg.localChecklistSeeders ? runSeeders(input.source).map((item) => ({ ...item, round })) : [];
  await input.logger.event("seeders_done", { round, enabled: input.cfg.localChecklistSeeders, nItems: seeded.length });

  if (input.cfg.dryRun || !input.llm) {
    await input.logger.artifact("checklist.json", seeded);
    return seeded;
  }

  const sourceIndex = input.sourceIndex ?? new SourceIndex(input.source);
  const proofObligations = input.proofObligations ?? [];
  const provenanceGraphs = input.provenanceGraphs ?? [];
  const enumContext = await buildEnumerationContext({
    cfg: input.cfg,
    corpus: input.corpus,
    source: input.source,
    sourceIndex,
    proofObligations,
    provenanceGraphs,
    round,
  });
  await input.logger.artifact(`round_${round}_enumeration_context_retrieval.json`, enumContext.trace);
  const user = buildEnumerationPrompt({
    target: input.cfg.targetName,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    proofObligations: renderProofObligations(proofObligations),
    provenanceFacts: provenanceGraphs.map((graph) => renderProvenanceGraph(graph)).filter(Boolean).join("\n\n"),
    corpus: enumContext.corpus,
    source: enumContext.source,
  });
  const text = await input.llm.complete({
    tag: "enumerate",
    system: ENUM_SYSTEM,
    user,
    model: input.cfg.enumModel,
    maxTokens: input.cfg.maxTokens,
    thinkingLevel: input.cfg.thinkingLevel,
  });

  const llmItems = extractJsonArray<RawAuditItem>(text).map((item) => normalizeAuditItem(item, round)).filter((item): item is AuditItem => item !== undefined);
  const portfolioItems = await enumeratePortfolios({
    cfg: input.cfg,
    corpus: enumContext.corpus,
    source: enumContext.source,
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    proofObligations,
    provenanceGraphs,
    llm: input.llm,
    logger: input.logger,
    round,
  });
  const deduped = dedupeAuditItems([...seeded, ...portfolioItems, ...llmItems]);
  const roundOneBudget = initialEnumerationBudget(input.cfg);
  const all = selectDiverseAuditItems(deduped, roundOneBudget);
  if (all.length < deduped.length) {
    await input.logger.event("enumeration_limited", {
      maxAuditItems: input.cfg.maxAuditItems,
      roundOneBudget,
      reservedForLaterRounds: reservedForLaterRounds(input.cfg),
      before: deduped.length,
      after: all.length,
    });
  }
  await input.logger.artifact("checklist.json", all);
  await input.logger.event("enumeration_done", {
    seeded: seeded.length,
    llm: llmItems.length,
    portfolio: portfolioItems.length,
    deduped: deduped.length,
    total: all.length,
  });
  return all;
}

async function enumeratePortfolios(input: {
  cfg: AuditorConfig;
  corpus: string;
  source: string;
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  lensPacks: string;
  proofObligations: ProofObligation[];
  provenanceGraphs: ProvenanceGraph[];
  llm: LlmClient;
  logger: RunLogger;
  round: number;
}): Promise<AuditItem[]> {
  if (!input.cfg.portfolioEnumeration) return [];
  const provenanceObligations = input.proofObligations.filter((obligation) => obligation.kind === "provenance");
  if (provenanceObligations.length === 0 || input.provenanceGraphs.length === 0) return [];
  const maxItems = Math.max(1, Math.floor(input.cfg.portfolioMaxItems));
  const user = buildPortfolioEnumerationPrompt({
    target: input.cfg.targetName,
    portfolio: "assignment/dataflow evidence",
    maxItems,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile,
    projectLearning: input.projectLearning,
    projectContext: input.projectContext,
    lensPacks: input.lensPacks,
    proofObligations: renderProofObligations(provenanceObligations, Math.max(12, maxItems * 6)),
    provenanceFacts: input.provenanceGraphs.map((graph) => renderProvenanceGraph(graph, Math.max(80, maxItems * 12))).filter(Boolean).join("\n\n"),
    corpus: input.corpus,
    source: input.source,
  });
  try {
    const text = await input.llm.complete({
      tag: "enumerate_assignment_dataflow",
      system: ENUM_SYSTEM,
      user,
      model: input.cfg.enumModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    const items = extractJsonArray<RawAuditItem>(text)
      .slice(0, maxItems)
      .map((item) => normalizeAuditItem(item, input.round))
      .filter((item): item is AuditItem => item !== undefined);
    await input.logger.event("portfolio_enumeration_done", { portfolio: "assignment/dataflow", items: items.length });
    return items;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.logger.event("portfolio_enumeration_error", { portfolio: "assignment/dataflow", error: message.slice(0, 500) });
    return [];
  }
}

function initialEnumerationBudget(cfg: Pick<AuditorConfig, "maxAuditItems" | "rounds" | "maxNewItemsPerRound">): number | undefined {
  if (typeof cfg.maxAuditItems !== "number" || !Number.isFinite(cfg.maxAuditItems) || cfg.maxAuditItems < 1) return undefined;
  const maxAuditItems = Math.floor(cfg.maxAuditItems);
  const rounds = Math.max(1, Math.floor(cfg.rounds));
  if (rounds <= 1) return maxAuditItems;
  const reserved = reservedForLaterRounds(cfg);
  return Math.max(1, maxAuditItems - reserved);
}

function reservedForLaterRounds(cfg: Pick<AuditorConfig, "maxAuditItems" | "rounds" | "maxNewItemsPerRound">): number {
  if (typeof cfg.maxAuditItems !== "number" || !Number.isFinite(cfg.maxAuditItems) || cfg.maxAuditItems < 1) return 0;
  const maxAuditItems = Math.floor(cfg.maxAuditItems);
  const rounds = Math.max(1, Math.floor(cfg.rounds));
  const perRound = Math.max(1, Math.floor(cfg.maxNewItemsPerRound));
  const laterCapacity = Math.max(0, rounds - 1) * perRound;
  return Math.min(maxAuditItems - 1, laterCapacity);
}

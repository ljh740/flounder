import type { AuditorConfig } from "./config.js";
import { effectiveFailureModes } from "./config.js";
import { buildEnumerationPrompt, ENUM_SYSTEM } from "./agents/prompts.js";
import { assemble } from "./ingest/source.js";
import { renderProjectLearning } from "./learn/project.js";
import { renderLensPacks, renderProjectContext } from "./lens/context.js";
import { renderProjectProfile } from "./profile/project.js";
import { runSeeders } from "./seeders/index.js";
import type { AuditItem, Doc, LlmClient, ProjectLearning, ProjectProfile } from "./types.js";
import { extractJsonArray } from "./util/json.js";
import type { RunLogger } from "./trace/logger.js";
import { dedupeAuditItems, normalizeAuditItem, selectDiverseAuditItems, type RawAuditItem } from "./items.js";

export async function enumerateAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  projectProfile?: ProjectProfile;
  projectLearning?: ProjectLearning;
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

  const corpusText = assemble(input.corpus, Math.floor(input.cfg.contextCharBudget / 2));
  const sourceText = assemble(input.source, Math.floor(input.cfg.contextCharBudget / 2), true);
  const user = buildEnumerationPrompt({
    target: input.cfg.targetName,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    corpus: corpusText,
    source: sourceText,
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
  const deduped = dedupeAuditItems([...seeded, ...llmItems]);
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
  await input.logger.event("enumeration_done", { seeded: seeded.length, llm: llmItems.length, deduped: deduped.length, total: all.length });
  return all;
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

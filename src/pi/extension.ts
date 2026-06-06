import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent, type UserBashEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultConfig } from "../config.js";
import { normalizeLensPacks, normalizeProjectContext } from "../lens/context.js";
import { runPipeline } from "../pipeline.js";
import { analyzeCommandSafety } from "../security/policy.js";
import { resolveLastRunDir } from "../trace/last-run.js";

export default function fullStackAuditorExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fsa_run_audit",
    label: "Run Security Audit",
    description:
      "Run the full-stack-auditor white-hat audit pipeline against local authorized source paths. Defaults to dry-run unless explicitly disabled.",
    parameters: Type.Object({
      target: Type.String({ description: "Target name used for run artifacts." }),
      sourcePaths: Type.Array(Type.String(), { description: "Local source files or directories to audit." }),
      corpusPaths: Type.Optional(Type.Array(Type.String(), { description: "Local spec/reference files or directories." })),
      provider: Type.Optional(Type.String({ description: "pi-ai provider, for example openai; use codex-cli or claude-code only as explicit local CLI fallbacks." })),
      model: Type.Optional(Type.String({ description: "Model id for enum/audit/verify stages." })),
      rounds: Type.Optional(Type.Number({ description: "Project exploration rounds. Later rounds generate novel follow-up audit items." })),
      explorationStrategy: Type.Optional(Type.String({ description: "Deepening strategy for later rounds: breadth, depth, or hybrid." })),
      maxNewItemsPerRound: Type.Optional(Type.Number({ description: "Cap new deepening items per round." })),
      trials: Type.Optional(Type.Number({ description: "Independent audit trials per item." })),
      maxAuditItems: Type.Optional(Type.Number({ description: "Optional cap on total audit items across rounds for cost-controlled runs." })),
      contextRetrieval: Type.Optional(Type.String({ description: "Context retrieval mode: source-index or source-index+qmd." })),
      qmdCommand: Type.Optional(Type.String({ description: "QMD CLI command when contextRetrieval is source-index+qmd." })),
      qmdLimit: Type.Optional(Type.Number({ description: "Maximum QMD hits per audit item." })),
      qmdMinScore: Type.Optional(Type.Number({ description: "Minimum QMD hit score." })),
      qmdTimeoutMs: Type.Optional(Type.Number({ description: "QMD query timeout in milliseconds." })),
      qmdCollections: Type.Optional(Type.Array(Type.String(), { description: "Optional QMD collections to search." })),
      outputDir: Type.Optional(Type.String({ description: "Artifact output directory." })),
      resumeRunDir: Type.Optional(Type.String({ description: "Existing run directory to continue, or 'last' to use the latest run under outputDir." })),
      resumeLast: Type.Optional(Type.Boolean({ description: "When true, continue the latest run under outputDir." })),
      projectContext: Type.Optional(Type.Any({ description: "Project-specific assets, threats, invariants, focus areas, and out-of-scope notes." })),
      lensPacks: Type.Optional(Type.Array(Type.Any(), { description: "Project-specific audit lens packs." })),
      projectLearning: Type.Optional(Type.Boolean({ description: "When true in live runs, let the model write initialization learning notes before lens discovery." })),
      dynamicLensDiscovery: Type.Optional(Type.Boolean({ description: "When true in live runs, let the model propose project-specific lens packs before enumeration." })),
      localChecklistSeeders: Type.Optional(Type.Boolean({ description: "When true, add deterministic local checklist seeders as coverage hints." })),
      dryRun: Type.Optional(Type.Boolean({ description: "When true, run local checklist seeders only and make no model calls." })),
    }),
    async execute(_toolCallId, params) {
      const cfg = defaultConfig();
      cfg.targetName = params.target;
      cfg.sourcePaths = params.sourcePaths;
      cfg.corpusPaths = params.corpusPaths ?? [];
      cfg.provider = params.provider ?? cfg.provider;
      cfg.rounds = params.rounds ?? cfg.rounds;
      if (params.explorationStrategy === "breadth" || params.explorationStrategy === "depth" || params.explorationStrategy === "hybrid") {
        cfg.explorationStrategy = params.explorationStrategy;
      }
      cfg.maxNewItemsPerRound = params.maxNewItemsPerRound ?? cfg.maxNewItemsPerRound;
      cfg.trials = params.trials ?? cfg.trials;
      if (params.maxAuditItems !== undefined) cfg.maxAuditItems = params.maxAuditItems;
      if (params.contextRetrieval === "source-index" || params.contextRetrieval === "source-index+qmd") cfg.contextRetrieval = params.contextRetrieval;
      cfg.qmdCommand = params.qmdCommand ?? cfg.qmdCommand;
      cfg.qmdLimit = params.qmdLimit ?? cfg.qmdLimit;
      cfg.qmdMinScore = params.qmdMinScore ?? cfg.qmdMinScore;
      cfg.qmdTimeoutMs = params.qmdTimeoutMs ?? cfg.qmdTimeoutMs;
      cfg.qmdCollections = params.qmdCollections ?? cfg.qmdCollections;
      cfg.outputDir = params.outputDir ?? cfg.outputDir;
      cfg.dryRun = params.dryRun ?? true;
      cfg.projectContext = normalizeProjectContext(params.projectContext) ?? cfg.projectContext;
      cfg.lensPacks = normalizeLensPacks(params.lensPacks);
      cfg.projectLearning = params.projectLearning ?? cfg.projectLearning;
      cfg.dynamicLensDiscovery = params.dynamicLensDiscovery ?? cfg.dynamicLensDiscovery;
      cfg.localChecklistSeeders = params.localChecklistSeeders ?? cfg.dryRun;
      if (params.model) {
        cfg.enumModel = params.model;
        cfg.auditModel = params.model;
        cfg.verifyModel = params.model;
      }

      const resumeRunDir =
        params.resumeLast || params.resumeRunDir === "last"
          ? await resolveLastRunDir(cfg.outputDir)
          : params.resumeRunDir;
      const result = await runPipeline(cfg, { ...(resumeRunDir ? { resumeRunDir } : {}) });
      return {
        content: [
          {
            type: "text",
            text: `Run dir: ${result.runDir}\nFindings: ${result.summary.coverage.itemsWithFinding}/${result.summary.coverage.itemsTotal}\nBy severity: ${JSON.stringify(result.summary.coverage.bySeverity)}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerCommand("fsa", {
    description: "Show full-stack-auditor usage.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Use the fsa_run_audit tool or run `fsa run --dry-run` from the terminal.", "info");
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const decision = analyzeCommandSafety(event.input.command);
    if (decision.blocked) {
      return {
        block: true,
        reason: decision.reason ?? "Blocked by full-stack-auditor.",
      };
    }
    return undefined;
  });

  pi.on("user_bash", async (event: UserBashEvent) => {
    const decision = analyzeCommandSafety(event.command);
    if (!decision.blocked) return undefined;
    return {
      result: {
        output: decision.reason ?? "Blocked by full-stack-auditor.",
        exitCode: 2,
        cancelled: false,
        truncated: false,
      },
    };
  });
}

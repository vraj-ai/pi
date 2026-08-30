import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import {
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  emptyGitInfoState,
  emptyModelInfoState,
  isGitInfoState,
  isModelInfoState,
  type GitInfoState,
  type ModelInfoState,
} from "../shared/dashboard-state.ts";
import {
  SUBAGENT_STATE_CHANNEL,
  isSubagentSummary,
  type SubagentSummary,
} from "../shared/workflow-state.ts";
import { columns, renderFooter } from "./footer.ts";
import { pickWhimsy, renderWhimsy, type WhimsyLine } from "./whimsy.ts";
import {
  normalizeMaxLines,
  renderStatusWidget,
  type StatusWidgetAgent,
  type StatusWidgetContext,
} from "./status-widget.ts";

const RESERVED_ROWS = 6;

type Activity = "idle" | "working" | "done" | "error";

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
}

function titleFor(ctx: ExtensionContext, activity: Activity) {
  const glyph =
    activity === "working"
      ? "·"
      : activity === "error"
        ? "×"
        : activity === "done"
          ? "✓"
          : "?";
  return `${glyph} π ${formatDirectory(ctx.cwd)}`;
}

export default function uiCustomization(pi: ExtensionAPI) {
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let agents: SubagentSummary[] = [];
  let agentsAt = 0;
  let activity: Activity = "idle";
  let activeTui: { requestRender(force?: boolean): void } | undefined;
  let currentContext: ExtensionContext | undefined;
  let whimsy: WhimsyLine | undefined;
  let previousWhimsy: string | undefined;

  const refresh = () => activeTui?.requestRender();
  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    refresh();
  });
  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    refresh();
  });
  const stopSubagentListener = pi.events.on(SUBAGENT_STATE_CHANNEL, (value) => {
    if (!Array.isArray(value)) return;
    agents = value.filter(isSubagentSummary);
    agentsAt = Date.now();
    refresh();
  });
  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, refresh);

  const install = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    currentContext = ctx;
    ctx.ui.setHeader((tui, theme) => {
      activeTui = tui;
      const directoryLabel = formatDirectory(ctx.cwd);
      return {
        render(width: number) {
          const identity =
            theme.fg("accent", "π") + theme.fg("text", ` ${directoryLabel}`);
          const identityWidth = 2 + directoryLabel.length;
          const aside = renderWhimsy(whimsy, width - identityWidth - 2);
          return [
            columns(identity, aside ? theme.fg("dim", aside) : "", width),
          ];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      return {
        invalidate() {},
        render(width: number) {
          const model = modelInfo.provider
            ? `${modelInfo.provider}/${modelInfo.modelId}`
            : modelInfo.modelId;
          const runtime = `${model} · ${modelInfo.thinking}`;
          const context =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}%`;
          const contextWindow = modelInfo.contextWindow
            ? formatTokens(modelInfo.contextWindow)
            : "?";
          const tps =
            modelInfo.tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
          const usage = `${context}/${contextWindow} · $${modelInfo.cost.toFixed(2)} · ${tps}`;
          const git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} changed`
            : "no git";
          const pr =
            gitInfo.pullRequest && getCapabilities().hyperlinks
              ? hyperlink(
                  `PR #${gitInfo.pullRequest.number}`,
                  gitInfo.pullRequest.url,
                )
              : gitInfo.pullRequest
                ? `PR #${gitInfo.pullRequest.number}`
                : git;
          let statuses: string[] = [];
          try {
            statuses = Array.from(footerData.getExtensionStatuses().values());
          } catch {
            return renderFooter({
              width,
              theme,
              cwdLabel: formatDirectory(ctx.cwd),
              runtime,
              usage,
              pr,
              statuses: [],
            });
          }
          return renderFooter({
            width,
            theme,
            cwdLabel: formatDirectory(ctx.cwd),
            runtime,
            usage,
            pr,
            statuses,
          });
        },
      };
    });

    ctx.ui.setWidget?.(
      "vraj-status",
      (tui, _theme) => {
        const maxLines = normalizeMaxLines(undefined);
        let terminalRows: number | undefined;
        try {
          terminalRows = tui.terminal.rows;
        } catch {
          terminalRows = undefined;
        }
        return {
          render(width: number) {
            const now = Date.now();
            const widgetAgents: StatusWidgetAgent[] = [];
            for (const agent of agents) {
              const context: StatusWidgetContext =
                typeof agent.contextTokens === "number" &&
                Number.isFinite(agent.contextTokens) &&
                agent.contextTokens > 0 &&
                typeof agent.contextWindow === "number" &&
                Number.isFinite(agent.contextWindow) &&
                agent.contextWindow > 0
                  ? {
                      kind: "measured" as const,
                      percent:
                        (agent.contextTokens / agent.contextWindow) * 100,
                    }
                  : { kind: "unknown" as const };
              widgetAgents.push({
                label: agent.title || agent.id || "agent",
                status: agent.status,
                backend: agent.backend,
                model: agent.modelLabel ?? "?",
                startedAt: agent.startedAt,
                at: agentsAt,
                turns: agent.turns,
                context,
              });
            }
            return renderStatusWidget({
              width,
              maxLines,
              terminalRows,
              reservedRows: RESERVED_ROWS,
              now,
              agents: widgetAgents,
            });
          },
          invalidate() {},
        };
      },
      { placement: "belowEditor" },
    );

    ctx.ui.setTitle(titleFor(ctx, activity));
    pi.events.emit(REFRESH_CHANNEL, undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    agents = [];
    agentsAt = 0;
    activity = "idle";
    previousWhimsy = whimsy?.text;
    whimsy = pickWhimsy({ avoid: previousWhimsy });
    install(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    activity = "working";
    ctx.ui.setTitle(titleFor(ctx, activity));
    refresh();
  });
  pi.on("agent_settled", (_event, ctx) => {
    activity = "done";
    ctx.ui.setTitle(titleFor(ctx, activity));
    refresh();
  });
  pi.on("agent_end", (event, ctx) => {
    if (
      event.messages.some(
        (message) =>
          message.role === "assistant" && message.stopReason === "error",
      )
    )
      activity = "error";
    ctx.ui.setTitle(titleFor(ctx, activity));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    stopSubagentListener();
    stopRefreshListener();
    activeTui = undefined;
    currentContext = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget?.("vraj-status", undefined);
    }
  });
}

/**
 * PI Usage Statistics.
 *
 * Ported from the `@oh-my-pi/omp-stats` package in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc. See
 * `PROVENANCE.md` for what was taken, what was adapted, and why.
 *
 * Surface:
 * - `usage_stats` tool: any dashboard page as Markdown, for the model
 * - `/usage`          : open the local dashboard in a browser
 * - `/usage summary`  : the overview in the transcript
 * - `/usage sync`     : index new sessions now
 * - `/usage rebuild`  : drop the index and re-read every session log
 *
 * Two recorders keep the side logs fed: provider rate-limit headers become
 * `reported` subscription-limit snapshots, and compaction events become gain
 * records.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  behavior,
  costs,
  errors,
  gain,
  limitsLog,
  modelDashboard,
  openStats,
  overview,
  parseRange,
  projectsDashboard,
  providers,
  requests,
  runSync,
  status,
  tools,
  type StatsContext,
} from "./src/api.ts";
import { optionalTools } from "../shared/optional-tools.ts";
import { recordGain } from "./src/gain.ts";
import {
  renderBehavior,
  renderCosts,
  renderGain,
  renderOverview,
  renderProjects,
  renderProviders,
  renderRequests,
  renderTools,
} from "./src/markdown.ts";
import { TIME_RANGES, type TimeRange } from "./src/shared-types.ts";
import { startServer, type RunningServer } from "./src/server.ts";
import { recordSnapshots, snapshotsFromHeaders } from "./src/usage-windows.ts";

const VIEWS = [
  "overview",
  "models",
  "providers",
  "tools",
  "costs",
  "behavior",
  "projects",
  "gain",
  "requests",
  "errors",
] as const;
type View = (typeof VIEWS)[number];

const USAGE_ENTRY = "vraj-usage-stats";

function render(context: StatsContext, view: View, range: TimeRange) {
  switch (view) {
    case "overview":
      return renderOverview(overview(context, range), range);
    case "models":
      return renderOverview(
        {
          ...overview(context, range),
          byModel: modelDashboard(context, range).byModel,
        },
        range,
      );
    case "providers":
      return renderProviders(providers(context, range), range);
    case "tools":
      return renderTools(tools(context, range), range);
    case "costs":
      return renderCosts(costs(context, range), range);
    case "behavior":
      return renderBehavior(behavior(context, range), range);
    case "projects":
      return renderProjects(projectsDashboard(context, range), range);
    case "gain":
      return renderGain(gain(context, range), range);
    case "requests":
      return renderRequests(requests(context, range), range, "requests");
    case "errors":
      return renderRequests(errors(context, range), range, "errors");
  }
}

function openInBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

interface TextEntry {
  readonly text: string;
}

export interface UsageStatsOptions {
  /** Injected in tests so nothing touches the real agent directory. */
  readonly context?: StatsContext;
  readonly openBrowser?: (url: string) => boolean;
}

export default function usageStats(
  pi: ExtensionAPI,
  options: UsageStatsOptions = {},
) {
  let context: StatsContext | undefined = options.context;
  let server: RunningServer | undefined;
  let cwd = process.cwd();

  /**
   * Opening the index lazily keeps a session that never asks for statistics
   * from paying for a database handle.
   */
  const getContext = () => {
    if (!context) context = openStats();
    return context;
  };

  pi.registerEntryRenderer<TextEntry>(USAGE_ENTRY, (entry) => {
    const lines =
      typeof entry.data?.text === "string" ? entry.data.text.split("\n") : [];
    return { render: () => lines, invalidate() {} };
  });

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
  });

  // --- recorders -----------------------------------------------------------

  /**
   * Reported subscription limits. Providers publish their remaining quota in
   * response headers; nothing else in pi keeps them, so they are recorded here
   * as they go past. Failure is silent by design: statistics must never be able
   * to break a turn.
   */
  pi.on("after_provider_response", (event, ctx) => {
    try {
      const provider = ctx.model?.provider;
      if (!provider) return;
      const snapshots = snapshotsFromHeaders({
        provider,
        headers: event.headers ?? {},
        at: Date.now(),
      });
      if (snapshots.length === 0) return;
      recordSnapshots(limitsLog(getContext()), snapshots);
    } catch {
      // Recording is best effort.
    }
  });

  /** Compaction is the other place pi genuinely removes tokens from a turn. */
  pi.on("session_compact", (event) => {
    try {
      const summary = event.compactionEntry as unknown as {
        summary?: unknown;
        details?: { originalChars?: unknown };
      };
      const outputBytes =
        typeof summary?.summary === "string" ? summary.summary.length : 0;
      const originalBytes = Number(summary?.details?.originalChars ?? 0);
      if (!Number.isFinite(originalBytes) || originalBytes <= outputBytes)
        return;
      recordGain(getContext().paths.gainLog, {
        source: "compaction",
        at: Date.now(),
        folder: cwd,
        originalBytes,
        outputBytes,
      });
    } catch {
      // Recording is best effort.
    }
  });

  // --- tool ----------------------------------------------------------------

  // Registered always, offered only on request: a session that never asks
  // about spend should not carry this tool's schema on every turn.
  optionalTools.register({
    name: "usage_stats",
    summary: "Read local pi usage statistics (cost, tokens, models, tools)",
    leanDefault: "off",
    rationale:
      "Nothing needs it until you ask about spend; `/usage` works either way.",
  });

  pi.registerTool({
    name: "usage_stats",
    label: "Usage Statistics",
    description:
      "Read this machine's local pi usage statistics as Markdown: cost, tokens, models, providers, tools, projects, errors, user-behaviour signals, saved tokens, and subscription-limit windows. Data comes from the local session logs only - nothing is sent anywhere. Use it to answer questions about spend, which model or tool is expensive, error rates, or how much a project has cost.",
    promptSnippet:
      "Read local pi usage statistics (cost, tokens, models, tools)",
    promptGuidelines: [
      "Pick the narrowest range that answers the question; 'all' scans the entire history.",
      "Latency and tokens-per-second are derived from entry timestamps and include local tool time - do not present them as provider-measured.",
      "Subscription-limit rows are labelled reported or estimated; never present an estimate as the provider's own number.",
    ],
    parameters: Type.Object({
      view: StringEnum(VIEWS, {
        description:
          "Which page to render: overview, models, providers, tools, costs, behavior, projects, gain, requests, errors",
      }),
      range: Type.Optional(
        StringEnum(TIME_RANGES, {
          description: "Time range (default 7d)",
        }),
      ),
      sync: Type.Optional(
        Type.Boolean({
          description:
            "Index new sessions before reading (default true). Set false for a fast read of the existing index.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const active = getContext();
      if (params.sync !== false) runSync(active);
      const range = parseRange(params.range);
      const text = render(active, params.view as View, range);
      const indexed = status(active);
      return {
        content: [
          {
            type: "text" as const,
            text: `${text}\n\n_Indexed ${indexed.indexedMessages} assistant messages from ${indexed.sessionFiles} session files._`,
          },
        ],
        details: { view: params.view, range, ...indexed },
      };
    },
  });

  // --- command -------------------------------------------------------------

  pi.registerCommand("usage", {
    description:
      "Usage statistics: /usage [browser|summary|sync|rebuild] [range]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? "browser";
      const range = parseRange(tokens[1] ?? tokens[0]);
      const active = getContext();

      if (action === "rebuild") {
        ctx.ui.notify(
          "Rebuilding the usage index from every session log...",
          "info",
        );
        context = openStats({ rebuild: true });
        const result = runSync(context, { full: true });
        ctx.ui.notify(
          `Rebuilt: ${result.counts.messages} messages from ${result.changed}/${result.files} session files in ${Math.round(result.durationMs)}ms` +
            (result.failed ? ` (${result.failed} files failed)` : ""),
          result.failed ? "warning" : "info",
        );
        return;
      }

      if (action === "sync") {
        const result = runSync(active);
        ctx.ui.notify(
          `Indexed ${result.counts.messages} new messages from ${result.changed} changed session files`,
          "info",
        );
        return;
      }

      if (action === "summary") {
        // Asking for usage is the signal that the tool is worth its context.
        optionalTools.enableOnDemand("usage_stats");
        runSync(active);
        pi.appendEntry(USAGE_ENTRY, {
          text: render(active, "overview", range),
        });
        return;
      }

      // Default: the browser dashboard.
      runSync(active);
      if (!server) {
        try {
          server = await startServer(active);
        } catch (error) {
          ctx.ui.notify(
            `Could not start the usage dashboard: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
      }
      const opened = (options.openBrowser ?? openInBrowser)(server.url);
      ctx.ui.notify(
        opened
          ? `Usage dashboard: ${server.url}`
          : `Usage dashboard running at ${server.url} (open it manually)`,
        "info",
      );
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = server;
    server = undefined;
    await closing?.close();
    context?.db.close();
    context = options.context;
  });
}

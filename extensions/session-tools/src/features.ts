/**
 * `/features`: what this harness actually gives you right now.
 *
 * Every optional dependency is probed rather than assumed, so the listing
 * tells the truth about a machine that is missing `fd`, `rg`, `gh`, or one of
 * the optional subagent CLIs, instead of advertising a feature that will fail
 * on first use.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { OptionalTool, ToolState } from "../../shared/optional-tools.ts";

export interface FeatureDependency {
  readonly kind: "binary" | "env";
  /** Executable names (any one satisfies it) or the env var name. */
  readonly names: readonly string[];
  /** What stops working without it. */
  readonly impact: string;
}

export interface Feature {
  readonly name: string;
  readonly summary: string;
  /** Commands, shortcuts, and tools this feature exposes. */
  readonly surface: readonly string[];
  readonly requires?: readonly FeatureDependency[];
}

export const FEATURES: readonly Feature[] = [
  {
    name: "Header and footer",
    summary:
      "Compact `π <dir>` header with a rotating joke or fact; two-line technical footer (model, thinking, context, cost, tok/s, git, PR); below-editor list of active subagents.",
    surface: ["header", "footer", "belowEditor subagent status"],
  },
  {
    name: "Copy and export",
    summary:
      "Copy or export the thread with secrets redacted before anything leaves the session.",
    surface: ["/copy-all", "/copy-last", "/copy-code", "/export"],
  },
  {
    name: "Skills manager",
    summary:
      "Enable or disable individual skills per scope; disabled skills leave the system prompt entirely.",
    surface: ["/skills", "/context-audit"],
  },
  {
    name: "Herdr subagents",
    summary:
      "Read-only background agents across six harnesses, max 4 concurrent, no takeover.",
    surface: [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_check",
      "subagent_list",
      "/subagents",
      "/btw",
    ],
    requires: [
      {
        kind: "binary",
        names: ["claude"],
        impact: "the claude harness",
      },
      { kind: "binary", names: ["codex"], impact: "the codex harness" },
      {
        kind: "binary",
        names: ["agy", "antigravity"],
        impact: "the agy harness",
      },
      { kind: "binary", names: ["omp"], impact: "the omp harness" },
      { kind: "binary", names: ["grok"], impact: "the grok harness" },
    ],
  },
  {
    name: "File search",
    summary: "Fast file and content search backed by fd and ripgrep.",
    surface: ["find_files", "search_content"],
    requires: [
      { kind: "binary", names: ["fd", "fdfind"], impact: "filename search" },
      { kind: "binary", names: ["rg"], impact: "content search" },
    ],
  },
  {
    name: "Files browser",
    summary: "Browse the working tree and open a file into the prompt.",
    surface: ["/files"],
  },
  {
    name: "Output compression",
    summary:
      "Noisy tool output is compressed before it reaches the model; the original stays one call away.",
    surface: ["read_raw_output", "/raw"],
  },
  {
    name: "Git context",
    summary:
      "Branch, working tree, and recent commits injected before the turn, and only when they change.",
    surface: ["/lg", "/pr", "automatic git context injection"],
    requires: [
      { kind: "binary", names: ["git"], impact: "all git features" },
      { kind: "binary", names: ["gh"], impact: "pull-request lookup" },
    ],
  },
  {
    name: "Web",
    summary: "Search, scrape, crawl, and structured extraction via Firecrawl.",
    surface: ["search", "scrape", "crawl", "extract"],
    requires: [
      {
        kind: "env",
        names: ["FIRECRAWL_API_KEY"],
        impact: "every web tool",
      },
    ],
  },
  {
    name: "Usage statistics",
    summary:
      "Local, rebuildable index of session logs: cost, tokens, models, tools, projects, gain, and subscription limits.",
    surface: ["usage_stats", "/usage"],
  },
  {
    name: "Session tools",
    summary:
      "Destructive-command guard, sleep inhibition while a turn runs, and a continue shortcut.",
    surface: [
      "/safety",
      "/no-sleep",
      "/features",
      "/continue",
      "shift+alt+enter",
    ],
  },
  {
    name: "Ask the user",
    summary: "The model can ask one multiple-choice question mid-turn.",
    surface: ["ask_user"],
  },
  {
    name: "Background terminals",
    summary: "Long-running commands in managed background terminals.",
    surface: ["/ps", "background terminal tools"],
  },
  {
    name: "Themes",
    summary: "Cobalt Ink and Vraj Ink dark themes.",
    surface: ["cobalt-ink", "vraj-ink"],
  },
];

export interface DependencyStatus {
  readonly dependency: FeatureDependency;
  readonly available: boolean;
  readonly resolved?: string;
}

export interface FeatureStatus {
  readonly feature: Feature;
  readonly dependencies: readonly DependencyStatus[];
  /** True when every dependency is satisfied (or there are none). */
  readonly complete: boolean;
}

export interface ProbeOptions {
  readonly findBinary?: (names: readonly string[]) => string | undefined;
  readonly env?: Record<string, string | undefined>;
}

function defaultFindBinary(names: readonly string[]) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${name}${suffix}`);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Not this one.
        }
      }
    }
  }
  return undefined;
}

export function probeFeatures(
  options: ProbeOptions = {},
  features: readonly Feature[] = FEATURES,
): FeatureStatus[] {
  const findBinary = options.findBinary ?? defaultFindBinary;
  const env = options.env ?? process.env;

  return features.map((feature) => {
    const dependencies = (feature.requires ?? []).map((dependency) => {
      if (dependency.kind === "env") {
        const name = dependency.names.find((key) => (env[key] ?? "") !== "");
        return {
          dependency,
          available: name !== undefined,
          ...(name === undefined ? {} : { resolved: name }),
        };
      }
      const resolved = findBinary(dependency.names);
      return {
        dependency,
        available: resolved !== undefined,
        ...(resolved === undefined ? {} : { resolved }),
      };
    });
    return {
      feature,
      dependencies,
      complete: dependencies.every((status) => status.available),
    };
  });
}

export function formatFeatures(statuses: readonly FeatureStatus[]) {
  const lines: string[] = ["Pi harness features", ""];
  for (const { feature, dependencies, complete } of statuses) {
    lines.push(`${(complete ? "[ok]" : "[part]").padEnd(6)} ${feature.name}`);
    lines.push(`        ${feature.summary}`);
    lines.push(`        ${feature.surface.join("  ")}`);
    for (const status of dependencies) {
      const names = status.dependency.names.join(" or ");
      lines.push(
        status.available
          ? `        - ${names}: found${status.resolved ? ` (${status.resolved})` : ""}`
          : `        - ${names}: MISSING -> ${status.dependency.impact} is unavailable`,
      );
    }
    lines.push("");
  }
  const missing = statuses.filter((status) => !status.complete).length;
  lines.push(
    missing === 0
      ? "All optional dependencies are present."
      : `${missing} feature(s) are running with missing optional dependencies; everything else still works.`,
  );
  return lines.join("\n");
}

/**
 * Render which optional tools are currently offered to the model.
 *
 * Every registered tool costs context on every turn, so an off tool is a real
 * saving rather than a missing feature - the listing says why each one is safe
 * to leave off so the trade-off is visible.
 */
export function formatToolStates(
  entries: ReadonlyArray<{ tool: OptionalTool; state: ToolState }>,
  options: { verbose?: boolean; lean?: boolean } = {},
) {
  if (entries.length === 0) return "No optional tools registered.";
  const on = entries.filter((entry) => entry.state === "on");

  if (!options.verbose) {
    return `Optional tools: ${entries
      .map((entry) => `${entry.tool.name}=${entry.state}`)
      .join(" ")}`;
  }

  const lines = [
    `Optional tools (${on.length}/${entries.length} offered to the model${
      options.lean === undefined ? "" : options.lean ? ", lean" : ", full"
    })`,
    "",
  ];
  for (const { tool, state } of entries) {
    lines.push(`  [${state === "on" ? "on " : "off"}] ${tool.name}`);
    lines.push(`         ${tool.summary}`);
    if (state === "off") lines.push(`         ${tool.rationale}`);
  }
  lines.push("");
  lines.push(
    "  /features on <tool> · /features off <tool> · /features lean|full",
  );
  return lines.join("\n");
}

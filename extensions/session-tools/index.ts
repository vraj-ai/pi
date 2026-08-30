/**
 * session-tools: four small session-level controls that share one extension
 * shell because they are all about the host and the session rather than the
 * conversation.
 *
 * - safety:   block catastrophic shell commands (`/safety`)
 * - no-sleep: keep the machine awake while a turn runs (`/no-sleep`)
 * - features: what this harness provides, and what is missing (`/features`)
 * - continue: send "continue" when the agent is stopped (shift+alt+enter)
 *
 * The continue shortcut is adapted from `continue.ts` in Armin Ronacher's
 * "agent-stuff" Pi package (Apache-2.0).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { optionalTools, readLeanSetting } from "../shared/optional-tools.ts";
import {
  formatFeatures,
  formatToolStates,
  probeFeatures,
} from "./src/features.ts";
import { describeNoSleep, NoSleep, type NoSleepScope } from "./src/no-sleep.ts";
import { collectWarnings, inspectCommand } from "./src/safety.ts";

const FEATURES_ENTRY = "vraj-features";

/** Agent settings, or `{}` when unreadable. Only used for the lean default. */
function readAgentSettings(): Record<string, unknown> {
  try {
    const agentDir =
      process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const parsed: unknown = JSON.parse(
      readFileSync(join(agentDir, "settings.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface TextEntry {
  readonly text: string;
}

export interface SessionToolsOptions {
  readonly noSleep?: NoSleep;
}

export default function sessionTools(
  pi: ExtensionAPI,
  options: SessionToolsOptions = {},
) {
  let safetyEnabled = true;
  let safetyStrict = false;
  let noSleep = options.noSleep ?? new NoSleep();

  pi.registerEntryRenderer<TextEntry>(FEATURES_ENTRY, (entry) => {
    const lines =
      typeof entry.data?.text === "string" ? entry.data.text.split("\n") : [];
    return { render: () => lines, invalidate() {} };
  });

  // --- safety --------------------------------------------------------------

  pi.on("tool_call", (event, ctx) => {
    if (!safetyEnabled) return;
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown })?.command;
    if (typeof command !== "string") return;

    const verdict = inspectCommand(command, { strict: safetyStrict });
    if (!verdict.allowed) {
      ctx.ui.notify(`Safety guard blocked: ${verdict.rule?.id}`, "warning");
      return { block: true, reason: verdict.message };
    }
    for (const warning of collectWarnings(command)) {
      ctx.ui.notify(
        `Safety warning (${warning.id}): ${warning.reason}`,
        "warning",
      );
    }
  });

  pi.registerCommand("safety", {
    description:
      "Destructive-command guard: /safety [status|on|off|strict|rules]",
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument === "on") {
        safetyEnabled = true;
        safetyStrict = false;
      } else if (argument === "off") {
        safetyEnabled = false;
      } else if (argument === "strict") {
        safetyEnabled = true;
        safetyStrict = true;
      } else if (argument === "rules") {
        const { SAFETY_RULES } = await import("./src/safety.ts");
        ctx.ui.notify(
          SAFETY_RULES.map(
            (rule) => `${rule.level.padEnd(5)} ${rule.id}: ${rule.reason}`,
          ).join("\n"),
          "info",
        );
        return;
      } else if (argument && argument !== "status") {
        ctx.ui.notify("Usage: /safety [status|on|off|strict|rules]", "warning");
        return;
      }
      ctx.ui.notify(
        safetyEnabled
          ? `Safety guard is on${safetyStrict ? " (strict: warnings block too)" : ""}`
          : "Safety guard is OFF - destructive commands will run",
        safetyEnabled ? "info" : "warning",
      );
    },
  });

  // --- no-sleep ------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    // Bind the optional-tool registry to this session and apply the configured
    // default. Tools are registered by their own extensions at load time; this
    // is what decides which of them the model is actually offered.
    optionalTools.bind({
      getActiveTools: () => pi.getActiveTools(),
      getAllTools: () => pi.getAllTools(),
      setActiveTools: (names) => pi.setActiveTools(names),
    });
    optionalTools.setLean(readLeanSetting(readAgentSettings()));

    noSleep.stop();
    noSleep =
      options.noSleep ??
      new NoSleep({
        onError: (message) => {
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
        },
      });
    noSleep.setAgentActive(false);
  });
  pi.on("agent_start", () => noSleep.setAgentActive(true));
  pi.on("agent_settled", () => noSleep.setAgentActive(false));
  pi.on("session_shutdown", () => {
    noSleep.stop();
    optionalTools.unbind();
  });

  pi.registerCommand("no-sleep", {
    description:
      "Keep the machine awake while the agent runs: /no-sleep [status|on|off|agent|session]",
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument === "on") noSleep.setEnabled(true);
      else if (argument === "off") noSleep.setEnabled(false);
      else if (argument === "agent" || argument === "session") {
        noSleep.setScope(argument as NoSleepScope);
      } else if (argument && argument !== "status") {
        ctx.ui.notify(
          "Usage: /no-sleep [status|on|off|agent|session]",
          "warning",
        );
        return;
      }
      const state = noSleep.state;
      ctx.ui.notify(
        describeNoSleep(state),
        state.lastError ? "warning" : "info",
      );
    },
  });

  // --- features ------------------------------------------------------------

  pi.registerCommand("features", {
    description:
      "Features and optional tools: /features [on <tool>|off <tool>|lean|full]",
    handler: async (args, ctx) => {
      const [action, target] = args.trim().split(/\s+/).filter(Boolean);

      if (action === "lean" || action === "full") {
        optionalTools.setLean(action === "lean");
        ctx.ui.notify(
          `Tool set: ${action}. ${formatToolStates(optionalTools.list())}`,
          "info",
        );
        return;
      }

      if (action === "on" || action === "off") {
        if (!target) {
          ctx.ui.notify(`Usage: /features ${action} <tool>`, "warning");
          return;
        }
        if (!optionalTools.set(target, action === "on" ? "on" : "off")) {
          ctx.ui.notify(
            `Not an optional tool: ${target}. Optional: ${optionalTools
              .list()
              .map((entry) => entry.tool.name)
              .join(", ")}`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(`${target} is now ${action}`, "info");
        return;
      }

      if (action && action !== "status") {
        ctx.ui.notify(
          "Usage: /features [status|on <tool>|off <tool>|lean|full]",
          "warning",
        );
        return;
      }

      // A custom entry, not a message: this is for the human, and it would be
      // a lot of context for the model to carry for the rest of the session.
      pi.appendEntry(FEATURES_ENTRY, {
        text: `${formatFeatures(probeFeatures())}\n\n${formatToolStates(
          optionalTools.list(),
          { verbose: true, lean: optionalTools.lean },
        )}`,
      });
    },
  });

  // --- continue ------------------------------------------------------------

  const sendContinue = (ctx: { isIdle(): boolean }) => {
    // isIdle() is also false while pi is retrying, compacting, or holding
    // queued messages, so this can never turn into an accidental steer.
    if (!ctx.isIdle()) return;
    pi.sendUserMessage("continue");
  };

  pi.registerShortcut("shift+alt+enter", {
    description: 'Send "continue" when the agent is stopped',
    handler: sendContinue,
  });

  pi.registerCommand("continue", {
    description: 'Send "continue" when the agent is stopped',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is still working", "info");
        return;
      }
      sendContinue(ctx);
    },
  });
}

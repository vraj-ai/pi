/**
 * The copy/export family.
 *
 * - `/copy-all`  entire thread to the clipboard
 * - `/copy-last` the last assistant reply to the clipboard
 * - `/copy-code` every fenced code block from the last assistant reply
 * - `/export`    the thread to a file (markdown by default, `--json`/`--text`)
 *
 * Every path runs through `collectSections`, which redacts secrets before the
 * text leaves the session.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  collectSections,
  defaultExportName,
  extractCodeBlocks,
  formatSections,
  parseForce,
  parseFormat,
  parsePath,
  resolveExportTarget,
  type ExportSection,
} from "./src/export.ts";

function branchOf(ctx: ExtensionCommandContext): readonly unknown[] {
  try {
    return ctx.sessionManager.getBranch() as readonly unknown[];
  } catch {
    return [];
  }
}

async function copy(ctx: ExtensionCommandContext, text: string, note: string) {
  try {
    await copyToClipboard(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Clipboard unavailable: ${message}`, "error");
    return;
  }
  ctx.ui.notify(note, "info");
}

function lastAssistant(sections: readonly ExportSection[]) {
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (sections[index].role === "assistant") return sections[index];
  }
  return undefined;
}

export default function copyExport(pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description:
      "Copy every user and assistant message in this thread to the clipboard (secrets redacted)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sections = collectSections(branchOf(ctx));
      if (sections.length === 0) {
        ctx.ui.notify("No user or assistant messages to copy", "info");
        return;
      }
      await copy(
        ctx,
        formatSections(sections, { format: "text" }),
        `Copied ${sections.length} messages to clipboard`,
      );
    },
  });

  pi.registerCommand("copy-last", {
    description:
      "Copy the last assistant reply to the clipboard (secrets redacted)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const last = lastAssistant(collectSections(branchOf(ctx)));
      if (!last) {
        ctx.ui.notify("No assistant reply to copy", "info");
        return;
      }
      await copy(ctx, last.text, "Copied the last assistant reply");
    },
  });

  pi.registerCommand("copy-code", {
    description:
      "Copy the code blocks from the last assistant reply to the clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const last = lastAssistant(collectSections(branchOf(ctx)));
      const blocks = last ? extractCodeBlocks(last.text) : [];
      if (blocks.length === 0) {
        ctx.ui.notify("No code blocks in the last assistant reply", "info");
        return;
      }
      await copy(
        ctx,
        blocks.map((block) => block.code).join("\n\n"),
        `Copied ${blocks.length} code block${blocks.length === 1 ? "" : "s"}`,
      );
    },
  });

  pi.registerCommand("export", {
    description:
      "Export this thread to a file: /export [path] [--json|--text] [--force] (markdown by default; stays inside the working directory unless --force)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const sections = collectSections(branchOf(ctx));
      if (sections.length === 0) {
        ctx.ui.notify("No user or assistant messages to export", "info");
        return;
      }

      const format = parseFormat(args);
      const at = Date.now();
      const resolved = resolveExportTarget({
        requested: parsePath(args),
        cwd: ctx.cwd,
        defaultName: defaultExportName(format, at),
        force: parseForce(args),
      });
      if (!resolved.path) {
        ctx.ui.notify(
          resolved.error ?? "Could not resolve the export path",
          "warning",
        );
        return;
      }
      const target = resolved.path;

      const body = formatSections(sections, {
        format,
        title: `Pi session transcript (${sections.length} messages)`,
        exportedAt: at,
      });

      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `${body}\n`, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Export failed: ${message}`, "error");
        return;
      }
      ctx.ui.notify(
        `Exported ${sections.length} messages to ${target}`,
        "info",
      );
    },
  });
}

/**
 * `/files`: browse the working tree and drop a file reference into the prompt.
 *
 * The picker loop is built on `ctx.ui.select` rather than a bespoke overlay:
 * one component fewer to keep working across pi releases, and the interaction
 * (pick a directory to descend, pick a file to insert) is the same either way.
 *
 * `/files <text>` starts with a filter applied, which is usually faster than
 * walking down three directories.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  browserTitle,
  listDirectory,
  navigate,
  referenceFor,
} from "./src/browser.ts";

const HIDDEN_LABEL = "[toggle hidden files]";
const CANCEL_LABEL = "[cancel]";

export default function files(pi: ExtensionAPI) {
  pi.registerCommand("files", {
    description:
      "Browse the working tree and insert a file reference into the prompt: /files [filter]",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The files browser requires the interactive TUI",
          "warning",
        );
        return;
      }

      const root = ctx.cwd;
      let directory = root;
      let filter = args.trim();
      let showHidden = false;

      for (;;) {
        const rows = listDirectory(directory, root, { filter, showHidden });
        const labels = [
          ...rows.map((row) => row.label),
          HIDDEN_LABEL,
          CANCEL_LABEL,
        ];
        const title =
          browserTitle(directory, root) + (filter ? `  filter: ${filter}` : "");

        const choice = await ctx.ui.select(title, labels);
        if (choice === undefined || choice === CANCEL_LABEL) return;
        if (choice === HIDDEN_LABEL) {
          showHidden = !showHidden;
          continue;
        }

        const row = rows.find((candidate) => candidate.label === choice);
        if (!row) continue;

        const target = navigate(row, root);
        if (!target) {
          ctx.ui.notify(
            "That path is outside the working directory",
            "warning",
          );
          continue;
        }
        if ("directory" in target) {
          directory = target.directory;
          // A filter that matched here rarely matches one level down; dropping
          // it makes descending feel like browsing rather than searching.
          filter = "";
          continue;
        }

        const reference = referenceFor(target.file, root);
        ctx.ui.pasteToEditor(reference);
        ctx.ui.notify(`Inserted ${reference}`, "info");
        return;
      }
    },
  });
}

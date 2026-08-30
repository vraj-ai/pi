/**
 * output-compress: shrink noisy tool output before it reaches the model, and
 * keep the original one tool call away.
 *
 * Hooks `tool_result`, rewrites the text content when compression buys
 * something real, and registers `read_raw_output` (for the model) plus `/raw`
 * (for the user) to recover the original. Compression never runs unless the
 * raw text was successfully stored first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { optionalTools } from "../shared/optional-tools.ts";
import { recordGain } from "../usage-stats/src/gain.ts";
import { resolvePaths } from "../usage-stats/src/paths.ts";
import { compressOutput, recoveryFooter } from "./src/compress.ts";
import { RawStore } from "./src/raw-store.ts";

/**
 * Tools whose output is already curated, or whose content is structured data
 * the model parses. Compressing these costs correctness for no real saving.
 */
const SKIP_TOOLS = new Set([
  "read",
  "edit",
  "multiedit",
  "write",
  "ask_user",
  "read_raw_output",
]);

export interface OutputCompressOptions {
  /** Injectable for tests. */
  readonly store?: RawStore;
  /** Where saved-token records go. Defaults to the agent directory's gain log. */
  readonly gainLog?: string;
}

export default function outputCompress(
  pi: ExtensionAPI,
  options: OutputCompressOptions = {},
) {
  let store = options.store ?? new RawStore();
  const gainLog = options.gainLog ?? resolvePaths().gainLog;
  let cwd = process.cwd();

  pi.on("session_shutdown", () => {
    store.clear();
  });
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    // A fresh session must not inherit the previous session's handles: the
    // model would cite a `raw-3` that now means something else.
    store.clear();
    store = options.store ?? new RawStore();
  });

  pi.on("tool_result", (event) => {
    if (SKIP_TOOLS.has(event.toolName)) return;
    if (!Array.isArray(event.content)) return;

    let changed = false;
    const content = event.content.map((block) => {
      if (changed) return block;
      if (!block || block.type !== "text" || typeof block.text !== "string") {
        return block;
      }
      const result = compressOutput(block.text);
      if (!result.compressed) return block;

      // Store first. If the spill fails, the original is the only copy, so
      // hand it back untouched rather than trading it for tokens.
      const entry = store.put(event.toolName, block.text);
      if (!entry) return block;

      changed = true;
      // A handle now exists, so the recovery tool has become worth its context.
      optionalTools.enableOnDemand("read_raw_output");
      const text = result.text + recoveryFooter(result, entry.handle);
      // Feed the gain ledger: this is a real, measured saving, so it belongs in
      // /usage rather than only in a footer the user may never read.
      recordGain(gainLog, {
        source: "compression",
        at: Date.now(),
        folder: cwd,
        originalBytes: result.originalChars,
        outputBytes: text.length,
      });
      return { ...block, text };
    });

    return changed ? { content } : undefined;
  });

  // There is nothing to recover until something has been compressed, so this
  // tool stays out of the prompt until the first compression happens.
  optionalTools.register({
    name: "read_raw_output",
    summary: "Recover the full original behind a compressed tool output",
    leanDefault: "off",
    rationale:
      "Enabled automatically the first time an output is compressed; before that there is no handle to read.",
  });

  pi.registerTool({
    name: "read_raw_output",
    label: "Read Raw Output",
    description:
      "Read the uncompressed original of a tool output that was compressed. The compressed output names its handle. Use offset/limit to page through a large log instead of pulling it all into context.",
    promptSnippet: "Recover the full original text behind a compressed output",
    promptGuidelines: [
      "Only call read_raw_output when the compressed summary is genuinely insufficient - it re-adds everything compression removed.",
      "Prefer a bounded window (offset + limit) over reading a whole large log.",
    ],
    parameters: Type.Object({
      handle: Type.String({
        description: 'Handle from a compressed output, e.g. "raw-3"',
      }),
      offset: Type.Optional(
        Type.Number({
          description: "First line to return (0-based)",
          minimum: 0,
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum lines to return", minimum: 1 }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = store.read(params.handle, {
        offset: params.offset,
        limit: params.limit,
      });
      if (!result) {
        const known = store
          .list()
          .map((entry) => entry.handle)
          .join(", ");
        throw new Error(
          `Unknown raw output handle: ${params.handle}.` +
            (known
              ? ` Available: ${known}`
              : " No outputs have been compressed."),
        );
      }
      const end = result.offset + result.returnedLines;
      const header =
        `${result.entry.toolName} output, lines ${result.offset + 1}-${end}` +
        ` of ${result.totalLines}\n\n`;
      return {
        content: [{ type: "text" as const, text: header + result.text }],
        details: {
          handle: result.entry.handle,
          totalLines: result.totalLines,
          offset: result.offset,
          returnedLines: result.returnedLines,
        },
      };
    },
  });

  pi.registerCommand("raw", {
    description:
      "List compressed tool outputs, or show where one was spilled: /raw [handle]",
    handler: async (args, ctx) => {
      const handle = args.trim();
      if (!handle) {
        const entries = store.list();
        if (entries.length === 0) {
          ctx.ui.notify("Nothing has been compressed this session", "info");
          return;
        }
        ctx.ui.notify(
          entries
            .map(
              (entry) =>
                `${entry.handle}  ${entry.toolName}  ${entry.bytes} bytes  ${entry.path}`,
            )
            .join("\n"),
          "info",
        );
        return;
      }
      const entry = store.get(handle);
      if (!entry) {
        ctx.ui.notify(`Unknown handle: ${handle}`, "warning");
        return;
      }
      ctx.ui.notify(`${entry.handle}: ${entry.path}`, "info");
    },
  });
}

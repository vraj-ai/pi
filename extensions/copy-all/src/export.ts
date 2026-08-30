/**
 * Pure transcript extraction and formatting for the copy/export family.
 *
 * Everything leaving the session through this module is redacted first
 * (`redactSecrets` from the summaries extension is the single shared
 * implementation) because every consumer here writes to a clipboard or a file
 * on disk - both places a leaked key outlives the session.
 */

import { isAbsolute, join, resolve, sep } from "node:path";
import { redactSecrets } from "../../summaries/src/transcript.ts";

export type ExportFormat = "text" | "markdown" | "json";

export interface ExportSection {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Flatten a message's content blocks to plain text. */
export function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (!("type" in block)) return "";
      if (
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

interface BranchEntryLike {
  readonly type?: unknown;
  readonly message?: { readonly role?: unknown; readonly content?: unknown };
}

/**
 * Collect the user/assistant turns of a session branch, redacted. Malformed
 * entries are skipped rather than throwing, so one bad entry never costs the
 * user the whole export.
 */
export function collectSections(branch: readonly unknown[]): ExportSection[] {
  const sections: ExportSection[] = [];
  for (const raw of branch ?? []) {
    const entry = raw as BranchEntryLike;
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    let text: string;
    try {
      text = redactSecrets(textFromContent(entry.message.content)).trim();
    } catch {
      continue;
    }
    if (!text) continue;
    sections.push({ role, text });
  }
  return sections;
}

export interface CodeBlock {
  readonly language: string;
  readonly code: string;
}

/**
 * Pull fenced code blocks out of already-redacted text. Handles ``` and ~~~
 * fences of three or more characters, and tolerates an unterminated final
 * fence (a streamed answer that was interrupted mid-block).
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  if (typeof text !== "string" || !text) return [];
  const blocks: CodeBlock[] = [];
  const lines = text.split("\n");
  let fence: string | undefined;
  let language = "";
  let body: string[] = [];

  for (const line of lines) {
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/);
    if (fence === undefined) {
      if (open) {
        fence = open[1][0].repeat(3);
        language = open[2] ?? "";
        body = [];
      }
      continue;
    }
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1].startsWith(fence)) {
      const code = body.join("\n").trim();
      if (code) blocks.push({ language, code });
      fence = undefined;
      language = "";
      body = [];
      continue;
    }
    body.push(line);
  }

  // An unterminated fence still holds real code - keep it.
  if (fence !== undefined) {
    const code = body.join("\n").trim();
    if (code) blocks.push({ language, code });
  }
  return blocks;
}

function markdown(sections: readonly ExportSection[], title: string) {
  const parts = [`# ${title}`, ""];
  for (const { role, text } of sections) {
    parts.push(`## ${role === "user" ? "User" : "Assistant"}`, "", text, "");
  }
  return parts.join("\n").trimEnd();
}

function plain(sections: readonly ExportSection[]) {
  return sections
    .map(({ role, text }) => `${role.toUpperCase()}:\n${text}`)
    .join("\n\n---\n\n");
}

export interface FormatOptions {
  readonly format: ExportFormat;
  /** Heading for markdown and `title` for JSON. */
  readonly title?: string;
  /** Epoch ms stamped into the JSON envelope. */
  readonly exportedAt?: number;
}

/** Serialize collected sections. Never throws; JSON failures fall back to text. */
export function formatSections(
  sections: readonly ExportSection[],
  options: FormatOptions,
) {
  const title = options.title?.trim() || "Pi session transcript";
  if (options.format === "markdown") return markdown(sections, title);
  if (options.format === "json") {
    try {
      return JSON.stringify(
        {
          title,
          exportedAt: new Date(options.exportedAt ?? 0).toISOString(),
          redacted: true,
          messages: sections,
        },
        null,
        2,
      );
    } catch {
      return plain(sections);
    }
  }
  return plain(sections);
}

/** Map a `/export` argument string to a format. Unknown values fall back to markdown. */
export function parseFormat(args: string): ExportFormat {
  const flag = (args ?? "").toLowerCase();
  if (/(^|\s)(--)?json(\s|$)/.test(flag)) return "json";
  if (/(^|\s)(--)?(text|txt|plain)(\s|$)/.test(flag)) return "text";
  return "markdown";
}

/** True when the caller explicitly opted out of the working-directory fence. */
export function parseForce(args: string) {
  return /(^|\s)--force(\s|$)/.test(args ?? "");
}

/** The non-flag remainder of an argument string, used as an output path. */
export function parsePath(args: string) {
  const rest = (args ?? "")
    .split(/\s+/)
    .filter(
      (token) =>
        token &&
        !/^--?(json|markdown|md|text|txt|plain|force)$/i.test(token) &&
        !/^(json|markdown|md|text|txt|plain)$/i.test(token),
    );
  return rest.length > 0 ? rest.join(" ") : undefined;
}

/**
 * Resolve where `/export` may write.
 *
 * A redacted transcript is still the whole conversation, so the default target
 * is fenced to the working directory: a mistyped or model-suggested
 * `/export ../../.ssh/notes.md` should not silently write outside the project.
 * `--force` is the explicit way out, because there are legitimate reasons to
 * export to `~/Documents` and refusing outright would just get worked around.
 */
export interface ResolveTargetResult {
  readonly path?: string;
  readonly error?: string;
}

export function resolveExportTarget(options: {
  readonly requested: string | undefined;
  readonly cwd: string;
  readonly defaultName: string;
  readonly force: boolean;
}): ResolveTargetResult {
  const base = resolve(options.cwd);
  if (!options.requested) {
    return { path: join(base, options.defaultName) };
  }

  const target = isAbsolute(options.requested)
    ? resolve(options.requested)
    : resolve(base, options.requested);

  const inside = target === base || target.startsWith(`${base}${sep}`);
  if (inside || options.force) return { path: target };

  return {
    error:
      `Refusing to export outside ${base}: ${target}\n` +
      "The transcript is the whole conversation, so /export stays in the working directory by default.\n" +
      "Re-run with --force to write there deliberately.",
  };
}

export function extensionFor(format: ExportFormat) {
  return format === "json" ? "json" : format === "text" ? "txt" : "md";
}

/** Default filename for `/export`, e.g. `pi-transcript-2026-08-30T17-42-01.md`. */
export function defaultExportName(format: ExportFormat, at: number) {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pi-transcript-${stamp}.${extensionFor(format)}`;
}

/**
 * Compression for noisy tool output.
 *
 * Build logs, test runners, installers, and `find` over a big tree all produce
 * output where most lines carry no information: progress spinners, thousands of
 * near-identical lines, walls of blank lines, ANSI paint. Feeding that to a
 * model costs real tokens for nothing.
 *
 * Every transformation here is lossy but *recoverable*: the caller keeps the
 * raw text and the compressed form always names the recovery handle, so the
 * model can pull the original back when it actually needs it.
 */

import { stripNoise } from "./ansi.ts";

export { stripNoise };

export interface CompressOptions {
  /** Output at or below this many lines is passed through untouched. */
  readonly minLines?: number;
  /** Output at or below this many characters is passed through untouched. */
  readonly minChars?: number;
  /** Lines kept from the head when the middle has to be elided. */
  readonly headLines?: number;
  /** Lines kept from the tail when the middle has to be elided. */
  readonly tailLines?: number;
  /** A run of this many similar lines or more collapses to one summary line. */
  readonly runThreshold?: number;
}

export const DEFAULTS = {
  minLines: 40,
  minChars: 2_000,
  headLines: 60,
  tailLines: 40,
  runThreshold: 3,
} as const satisfies Required<CompressOptions>;

export interface CompressResult {
  readonly text: string;
  readonly compressed: boolean;
  readonly originalLines: number;
  readonly originalChars: number;
  readonly outputLines: number;
  readonly outputChars: number;
  /** What was applied, in order, for the recovery footer. */
  readonly applied: readonly string[];
}

/**
 * Fingerprint a line so "similar" means "same shape, different numbers/paths".
 * `Downloading foo-1.2.3.tgz (43%)` and `Downloading bar-9.0.0.tgz (7%)` share
 * a fingerprint; two genuinely different messages do not.
 */
export function fingerprint(line: string) {
  return line
    .trim()
    .replace(/\b[0-9a-f]{7,40}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ");
}

interface Run {
  /** Every line of the run, so declining to collapse restores them exactly. */
  readonly lines: string[];
}

/** Collapse consecutive runs of same-fingerprint lines into one summary line. */
export function collapseRuns(lines: readonly string[], threshold: number) {
  const runs: Run[] = [];
  let current: string[] | undefined;
  let currentPrint: string | undefined;

  const flush = () => {
    if (current === undefined) return;
    runs.push({ lines: current });
  };

  for (const line of lines) {
    const print = fingerprint(line);
    if (print === currentPrint && current !== undefined) {
      current.push(line);
      continue;
    }
    flush();
    current = [line];
    currentPrint = print;
  }
  flush();

  const out: string[] = [];
  let collapsed = 0;
  for (const run of runs) {
    if (run.lines.length < threshold) {
      out.push(...run.lines);
      continue;
    }
    out.push(run.lines[0]);
    out.push(`    ... ${run.lines.length - 1} more similar lines`);
    collapsed += run.lines.length - 1;
  }
  return { lines: out, collapsed };
}

/** Collapse three or more consecutive blank lines down to one. */
export function collapseBlanks(lines: readonly string[]) {
  const out: string[] = [];
  let blanks = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks += 1;
      if (blanks > 1) {
        removed += 1;
        continue;
      }
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return { lines: out, removed };
}

/**
 * Compress `text`. Returns `compressed: false` and the input untouched when the
 * output is small enough to be worth keeping verbatim.
 */
export function compressOutput(
  text: string,
  options: CompressOptions = {},
): CompressResult {
  const source = typeof text === "string" ? text : "";
  const config = { ...DEFAULTS, ...options };
  const originalLines = source === "" ? 0 : source.split("\n").length;
  const originalChars = source.length;

  const unchanged: CompressResult = {
    text: source,
    compressed: false,
    originalLines,
    originalChars,
    outputLines: originalLines,
    outputChars: originalChars,
    applied: [],
  };

  if (originalLines <= config.minLines && originalChars <= config.minChars) {
    return unchanged;
  }

  const applied: string[] = [];
  const stripped = stripNoise(source);
  if (stripped !== source) applied.push("stripped terminal control sequences");

  const blanks = collapseBlanks(stripped.split("\n"));
  if (blanks.removed > 0) {
    applied.push(`collapsed ${blanks.removed} blank lines`);
  }

  const runs = collapseRuns(blanks.lines, config.runThreshold);
  if (runs.collapsed > 0) {
    applied.push(`collapsed ${runs.collapsed} repeated lines`);
  }

  let lines = runs.lines;
  const budget = config.headLines + config.tailLines;
  if (lines.length > budget) {
    const elided = lines.length - budget;
    lines = [
      ...lines.slice(0, config.headLines),
      `    ... ${elided} lines elided from the middle ...`,
      ...lines.slice(lines.length - config.tailLines),
    ];
    applied.push(`elided ${elided} middle lines`);
  }

  const output = lines.join("\n");
  if (applied.length === 0 || output.length >= originalChars) {
    // Nothing meaningful was saved. Keeping the original avoids paying a
    // recovery footer for a rewrite that bought nothing.
    return unchanged;
  }

  return {
    text: output,
    compressed: true,
    originalLines,
    originalChars,
    outputLines: lines.length,
    outputChars: output.length,
    applied,
  };
}

/** The footer that tells the reader what happened and how to get the raw text. */
export function recoveryFooter(result: CompressResult, handle: string) {
  const saved = result.originalChars - result.outputChars;
  const percent = result.originalChars
    ? Math.round((saved / result.originalChars) * 100)
    : 0;
  return (
    `\n\n[output compressed: ${result.originalLines} lines -> ${result.outputLines}` +
    ` (${percent}% smaller). ${result.applied.join("; ")}.` +
    ` Full output: read_raw_output(handle: "${handle}")]`
  );
}

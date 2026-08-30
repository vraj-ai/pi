/**
 * Terminal control-sequence stripping, kept in its own module so the escape
 * codes live in exactly one place.
 */

const ESC = "\u001b";

/** CSI sequences (colour, cursor moves) and OSC sequences (titles, links). */
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${ESC}]*(?:|${ESC}\\\\)`,
  "g",
);

/**
 * A carriage return means the writer repainted the line in place (progress
 * bars, spinners). Only the final paint carries information, so keep the last
 * segment. A regex with `.` cannot be used: in JS `.` does not match `\r`.
 */
function lastPaint(line: string) {
  const segments = line.split("\r");
  return segments[segments.length - 1];
}

/** Other C0 control bytes that survive into captured output. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string) {
  return text.replace(ANSI, "");
}

export function stripNoise(text: string) {
  return stripAnsi(text)
    .split("\n")
    .map((line) => lastPaint(line).replace(CONTROL, ""))
    .join("\n");
}

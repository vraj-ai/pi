/**
 * Header whimsy: one clean, short joke or fact shown on the right of the
 * compact `π <dir>` header.
 *
 * Rules the spec locks in:
 * - clean: plain ASCII text, single line, no emoji, no ANSI, no control bytes
 * - random: a fresh pick per session, never the same line twice in a row
 * - unobtrusive: the header drops it entirely rather than truncating to nonsense
 */

export interface WhimsyLine {
  readonly kind: "joke" | "fact";
  readonly text: string;
}

/**
 * Curated so every entry fits a narrow terminal. Keep lines <= 64 visible
 * columns; `MAX_WHIMSY_WIDTH` is asserted over this table by the test suite.
 */
export const MAX_WHIMSY_WIDTH = 64;

export const WHIMSY_LINES: readonly WhimsyLine[] = [
  { kind: "joke", text: "There are two hard problems: naming and off-by-one" },
  { kind: "joke", text: "It works on my machine is a deployment strategy" },
  { kind: "joke", text: "A week of coding saves an hour of planning" },
  { kind: "joke", text: "The bug was in the last place I looked, obviously" },
  { kind: "joke", text: "Rubber ducks have solved more bugs than debuggers" },
  { kind: "joke", text: "Temporary fix, added 2019, still load-bearing" },
  { kind: "joke", text: "The fastest code is the code you deleted" },
  { kind: "joke", text: "Every regex is a small act of optimism" },
  { kind: "joke", text: "Yesterday's clever is today's incident report" },
  { kind: "joke", text: "Cache invalidation: still undefeated" },
  { kind: "joke", text: "TODO: remove before the demo. Shipped 2021" },
  { kind: "joke", text: "The tests pass locally and that is a kind of truth" },
  { kind: "fact", text: "The first computer bug was a moth, logged in 1947" },
  { kind: "fact", text: "Unix time crosses 2^31 seconds on 19 January 2038" },
  { kind: "fact", text: "grep is named for the ed command g/re/p" },
  {
    kind: "fact",
    text: "SQLite ships in more devices than any other database",
  },
  { kind: "fact", text: "Ctrl-C sends SIGINT; Ctrl-backslash sends SIGQUIT" },
  { kind: "fact", text: "Git stores every object under its own content hash" },
  { kind: "fact", text: "The term 'daemon' comes from Maxwell's demon" },
  { kind: "fact", text: "ASCII DEL is 127 because punched tape had no eraser" },
  { kind: "fact", text: "Dijkstra designed shortest-path in about 20 minutes" },
  {
    kind: "fact",
    text: "The 'ping' utility is named after sonar, by Mike Muuss",
  },
  { kind: "fact", text: "UTF-8 was sketched on a New Jersey diner placemat" },
  {
    kind: "fact",
    text: "A 'jiffy' in the Linux kernel is one timer-interrupt tick",
  },
];

/** Cheap deterministic hash so a given seed always yields the same line. */
function hashSeed(seed: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Strip anything that would smear across the single header row. */
export function cleanWhimsy(text: unknown) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PickWhimsyOptions {
  /** Deterministic seed. Omit for a random pick. */
  readonly seed?: string;
  /** Line to avoid repeating (the previous session's pick). */
  readonly avoid?: string;
  /** Restrict to one flavour. Omit for both. */
  readonly kind?: WhimsyLine["kind"];
  /** Injectable RNG for tests. Must return [0, 1). */
  readonly random?: () => number;
  readonly lines?: readonly WhimsyLine[];
}

/**
 * Pick one line. Returns `undefined` only when the pool is empty, so callers
 * can fall back to an empty header slot instead of rendering a placeholder.
 */
export function pickWhimsy(
  options: PickWhimsyOptions = {},
): WhimsyLine | undefined {
  const source = options.lines ?? WHIMSY_LINES;
  const pool = options.kind
    ? source.filter((line) => line.kind === options.kind)
    : source;
  if (pool.length === 0) return undefined;

  const avoid = cleanWhimsy(options.avoid);
  const candidates =
    avoid && pool.length > 1
      ? pool.filter((line) => cleanWhimsy(line.text) !== avoid)
      : pool;
  const usable = candidates.length > 0 ? candidates : pool;

  let index: number;
  if (options.seed !== undefined) {
    index = hashSeed(options.seed) % usable.length;
  } else {
    let roll: number;
    try {
      roll = (options.random ?? Math.random)();
    } catch {
      roll = 0;
    }
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) roll = 0;
    index = Math.floor(roll * usable.length);
  }

  const picked = usable[index] ?? usable[0];
  const text = cleanWhimsy(picked.text);
  return text ? { kind: picked.kind, text } : undefined;
}

/**
 * Render for the header's right column. Returns "" when the terminal is too
 * narrow to show the line whole - a half-joke is worse than no joke.
 */
export function renderWhimsy(
  line: WhimsyLine | undefined,
  availableWidth: number,
) {
  if (!line) return "";
  const width =
    typeof availableWidth === "number" && Number.isFinite(availableWidth)
      ? Math.floor(availableWidth)
      : 0;
  const text = cleanWhimsy(line.text);
  return text.length > 0 && text.length <= width ? text : "";
}

/**
 * Parse a pi session JSONL file into indexable rows.
 *
 * Ported from `packages/stats/src/parser.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc., and
 * rewritten for pi's session format:
 *
 * - pi records `usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens}`
 *   and a `usage.cost` breakdown directly on each assistant message, so there
 *   is no price table to apply and no "premium request" concept.
 * - pi records no request duration or TTFT. Duration is *derived* as the gap
 *   between an assistant message and the preceding entry, which is a real
 *   latency signal but includes local tool time, so it is labelled derived
 *   everywhere it surfaces.
 * - agent type comes from the session's own `session_info` name (pi writes
 *   "subagent: <title>" for children) rather than from the transcript path.
 *
 * The parser is incremental: it takes a byte offset, parses whole lines from
 * there, and reports the offset it stopped at, so a growing session file is
 * re-read only from where the last pass ended.
 */

import { basename, dirname } from "node:path";
import { folderFromSessionDir } from "./paths.ts";
import type { AgentType } from "./shared-types.ts";

export interface ParsedMessage {
  sessionFile: string;
  entryId: string;
  folder: string;
  model: string;
  provider: string;
  api: string;
  timestamp: number;
  durationMs: number | null;
  stopReason: string;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  agentType: AgentType;
}

export interface ParsedUserMessage {
  sessionFile: string;
  entryId: string;
  folder: string;
  timestamp: number;
  model: string | null;
  provider: string | null;
  chars: number;
  words: number;
  yelling: number;
  profanity: number;
  anguish: number;
  negation: number;
  repetition: number;
  blame: number;
}

export interface ParsedToolCall {
  sessionFile: string;
  entryId: string;
  toolCallId: string;
  folder: string;
  toolName: string;
  model: string;
  provider: string;
  timestamp: number;
  agentType: AgentType;
  callsInTurn: number;
  argsChars: number;
}

export interface ParsedToolResult {
  sessionFile: string;
  toolCallId: string;
  resultChars: number;
  isError: boolean;
}

export interface ParseResult {
  messages: ParsedMessage[];
  userMessages: ParsedUserMessage[];
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
  /** Byte offset of the end of the last complete line consumed. */
  offset: number;
  /** Lines that were not valid JSON. A corrupt line is skipped, not fatal. */
  skipped: number;
}

// --- behavioural signals ---------------------------------------------------

/**
 * Deliberately small and boring. These are frustration *signals*, not a
 * sentiment model: each one is a pattern a person actually types when an agent
 * is not doing what they asked.
 */
const PROFANITY =
  /\b(fuck\w*|shit\w*|damn|dammit|crap|bullshit|wtf|bloody hell|arse\w*|ass(hole)?)\b/gi;
const ANGUISH =
  /(\bno{2,}\b|\bugh+\b|\baar*gh+\b|\bdude\b|:\(|\bffs\b|\bomg\b)/gi;
const NEGATION =
  /\b(no|nope|nah|wrong|incorrect|that'?s not( what)?( i)?( meant)?|not what i (asked|meant|wanted))\b/gi;
const REPETITION =
  /\b(i (already )?(said|told you|meant)|like i said|again|still (doesn'?t|does not|not) work\w*|as i (said|mentioned))\b/gi;
const BLAME =
  /\b(you (didn'?t|did not|keep|always|never|broke|ignored)|why did you|stop \w+ing)\b/gi;

function countMatches(text: string, pattern: RegExp) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/** A sentence counts as yelling when more than half its letters are capitals. */
export function countYelling(text: string) {
  let yelling = 0;
  for (const sentence of text.split(/[.!?\n]+/)) {
    const letters = sentence.replace(/[^A-Za-z]/g, "");
    if (letters.length < 4) continue;
    const upper = sentence.replace(/[^A-Z]/g, "").length;
    if (upper / letters.length > 0.5) yelling += 1;
  }
  return yelling;
}

export function analyzeUserText(text: string) {
  return {
    chars: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    yelling: countYelling(text),
    profanity: countMatches(text, PROFANITY),
    anguish: countMatches(text, ANGUISH),
    negation: countMatches(text, NEGATION),
    repetition: countMatches(text, REPETITION),
    blame: countMatches(text, BLAME),
  };
}

// --- content helpers -------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("\n");
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

// --- parsing ---------------------------------------------------------------

interface ToolCallBlock {
  toolCallId: string;
  name: string;
  argsChars: number;
}

function toolCallsOf(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type !== "toolCall") continue;
    const id = typed.id ?? typed.toolCallId;
    if (typeof id !== "string" || !id) continue;
    let argsChars = 0;
    try {
      argsChars =
        JSON.stringify(typed.arguments ?? typed.args ?? {})?.length ?? 0;
    } catch {
      argsChars = 0;
    }
    calls.push({
      toolCallId: id,
      name: stringOr(typed.name, "unknown"),
      argsChars,
    });
  }
  return calls;
}

/**
 * Bounds on derived latency. Below the minimum the gap is log-write timing
 * rather than generation; above the maximum the session was simply idle.
 */
export const MIN_DERIVED_DURATION_MS = 250;
export const MAX_DERIVED_DURATION_MS = 10 * 60 * 1_000;

export interface ParseOptions {
  /** Byte offset to resume from. */
  readonly offset?: number;
  /** Overrides the folder derived from the session path (tests). */
  readonly folder?: string;
}

/**
 * Parse `content` (the whole file, or the tail beyond `offset`). `sessionFile`
 * is only used to label rows and derive the project folder - the caller owns
 * reading the bytes, so this stays pure and testable.
 */
export function parseSession(
  sessionFile: string,
  content: string,
  options: ParseOptions = {},
): ParseResult {
  const startOffset = options.offset ?? 0;
  const folder =
    options.folder ?? folderFromSessionDir(basename(dirname(sessionFile)));

  const result: ParseResult = {
    messages: [],
    userMessages: [],
    toolCalls: [],
    toolResults: [],
    offset: startOffset,
    skipped: 0,
  };

  // Only whole lines are consumed: a half-written final line is left for the
  // next pass rather than parsed as truncated JSON.
  const lastNewline = content.lastIndexOf("\n");
  if (lastNewline < 0) return result;
  const complete = content.slice(0, lastNewline + 1);
  result.offset = startOffset + Buffer.byteLength(complete, "utf8");

  let agentType: AgentType = "main";
  /** Timestamp of the previous entry, for deriving assistant latency. */
  let previousTimestamp: number | undefined;
  /** entryId -> user message index, for linking a reply's model back. */
  const userByEntry = new Map<string, number>();
  let lastUserEntryId: string | undefined;

  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a session entry");
      }
      entry = parsed as Record<string, unknown>;
    } catch {
      result.skipped += 1;
      continue;
    }

    if (entry.type === "session_info") {
      // pi names a child session "subagent: <title>". That is the only place
      // the transcript says who produced the messages that follow.
      if (
        typeof entry.name === "string" &&
        /^subagent\b/i.test(entry.name.trim())
      ) {
        agentType = "subagent";
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const entryId = stringOr(entry.id, "");
    if (!entryId) continue;

    if (message.role === "user") {
      const timestamp = Date.parse(stringOr(entry.timestamp, ""));
      if (!Number.isFinite(timestamp)) continue;
      const analysis = analyzeUserText(textOf(message.content));
      userByEntry.set(entryId, result.userMessages.length);
      lastUserEntryId = entryId;
      result.userMessages.push({
        sessionFile,
        entryId,
        folder,
        timestamp,
        model: null,
        provider: null,
        ...analysis,
      });
      previousTimestamp = timestamp;
      continue;
    }

    if (message.role === "toolResult") {
      const toolCallId = stringOr(message.toolCallId, "");
      if (toolCallId) {
        result.toolResults.push({
          sessionFile,
          toolCallId,
          resultChars: textOf(message.content).length,
          isError: message.isError === true,
        });
      }
      const timestamp = number(message.timestamp);
      if (timestamp > 0) previousTimestamp = timestamp;
      continue;
    }

    if (message.role !== "assistant") continue;

    const timestamp =
      number(message.timestamp) || Date.parse(stringOr(entry.timestamp, ""));
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;

    const usage = (message.usage ?? {}) as Record<string, unknown>;
    const cost = (usage.cost ?? {}) as Record<string, unknown>;
    const model = stringOr(message.model, "unknown");
    const provider = stringOr(message.provider, "unknown");

    // Derived latency: the gap since the previous entry, bounded at both ends.
    //
    // Upper bound: a session resumed the next morning would otherwise report a
    // 12-hour "request". Lower bound: pi stamps some entries within the same
    // millisecond, and a 1ms window against a 5,000-token reply yields a
    // 5,000,000 tok/s "measurement". Both extremes are reported as unknown
    // rather than as a number someone might believe.
    let durationMs: number | null = null;
    if (previousTimestamp !== undefined) {
      const delta = timestamp - previousTimestamp;
      if (
        delta >= MIN_DERIVED_DURATION_MS &&
        delta <= MAX_DERIVED_DURATION_MS
      ) {
        durationMs = delta;
      }
    }

    result.messages.push({
      sessionFile,
      entryId,
      folder,
      model,
      provider,
      api: stringOr(message.api, "unknown"),
      timestamp,
      durationMs,
      stopReason: stringOr(message.stopReason, "unknown"),
      errorMessage:
        typeof message.errorMessage === "string" ? message.errorMessage : null,
      inputTokens: number(usage.input),
      outputTokens: number(usage.output),
      cacheReadTokens: number(usage.cacheRead),
      cacheWriteTokens: number(usage.cacheWrite),
      reasoningTokens: number(usage.reasoning),
      totalTokens:
        number(usage.totalTokens) ||
        number(usage.input) +
          number(usage.output) +
          number(usage.cacheRead) +
          number(usage.cacheWrite),
      costInput: number(cost.input),
      costOutput: number(cost.output),
      costCacheRead: number(cost.cacheRead),
      costCacheWrite: number(cost.cacheWrite),
      costTotal: number(cost.total),
      agentType,
    });

    // Link the user message this replies to, so behaviour stats can be sliced
    // by the model that was actually answering.
    const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
    const linkTarget =
      parentId && userByEntry.has(parentId) ? parentId : lastUserEntryId;
    if (linkTarget !== undefined) {
      const index = userByEntry.get(linkTarget);
      if (index !== undefined && result.userMessages[index].model === null) {
        result.userMessages[index].model = model;
        result.userMessages[index].provider = provider;
      }
    }

    const calls = toolCallsOf(message.content);
    for (const call of calls) {
      result.toolCalls.push({
        sessionFile,
        entryId,
        toolCallId: call.toolCallId,
        folder,
        toolName: call.name,
        model,
        provider,
        timestamp,
        agentType,
        callsInTurn: calls.length,
        argsChars: call.argsChars,
      });
    }

    previousTimestamp = timestamp;
  }

  return result;
}

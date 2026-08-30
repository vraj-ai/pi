/**
 * Raw-output store: the recovery half of compression.
 *
 * Compression is only acceptable because the original is still reachable, so
 * the store is written before the compressed text is handed back, and it spills
 * to disk rather than pinning megabytes of build log in memory for a session
 * that may run for hours.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RawEntry {
  readonly handle: string;
  readonly toolName: string;
  readonly path: string;
  readonly bytes: number;
  readonly at: number;
}

/** Handles stay short and typo-resistant: the model retypes them by hand. */
export function makeHandle(sequence: number) {
  return `raw-${sequence}`;
}

export interface RawStoreOptions {
  /** Directory for spilled output. Defaults to a per-process temp directory. */
  readonly directory?: string;
  /** Entries retained; the oldest are dropped and their files deleted. */
  readonly maxEntries?: number;
}

export class RawStore {
  readonly #entries = new Map<string, RawEntry>();
  readonly #directory: string;
  readonly #maxEntries: number;
  #sequence = 0;

  constructor(options: RawStoreOptions = {}) {
    this.#directory =
      options.directory ?? join(tmpdir(), `pi-raw-output-${process.pid}`);
    this.#maxEntries = Math.max(1, options.maxEntries ?? 64);
  }

  get directory() {
    return this.#directory;
  }

  /**
   * Persist `text` and return its handle, or `undefined` when the write fails.
   * A failed write must make the caller skip compression entirely - losing the
   * original is never an acceptable outcome of trying to save tokens.
   */
  put(toolName: string, text: string): RawEntry | undefined {
    this.#sequence += 1;
    const handle = makeHandle(this.#sequence);
    const path = join(this.#directory, `${handle}.txt`);
    try {
      // Raw tool output is whole file contents, command output, and anything
      // else a tool returned. It lands in a shared temp directory, so it is
      // owner-only: 0700 on the directory, 0600 on each spill.
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      chmodSync(this.#directory, 0o700);
      writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      return undefined;
    }
    const entry: RawEntry = {
      handle,
      toolName,
      path,
      bytes: Buffer.byteLength(text, "utf8"),
      at: Date.now(),
    };
    this.#entries.set(handle, entry);
    this.#evict();
    return entry;
  }

  get(handle: string) {
    return this.#entries.get(handle);
  }

  /** Newest first. Insertion order breaks `at` ties within the same millisecond. */
  list(): readonly RawEntry[] {
    return [...this.#entries.values()].reverse();
  }

  /**
   * Read a stored output back. `offset`/`limit` are in lines so a huge log can
   * be walked in pages instead of blowing the context it was compressed out of.
   */
  read(handle: string, options: { offset?: number; limit?: number } = {}) {
    const entry = this.#entries.get(handle);
    if (!entry) return undefined;
    let text: string;
    try {
      text = readFileSync(entry.path, "utf8");
    } catch {
      return undefined;
    }
    const lines = text.split("\n");
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit =
      options.limit === undefined
        ? lines.length
        : Math.max(1, Math.floor(options.limit));
    const slice = lines.slice(offset, offset + limit);
    return {
      entry,
      text: slice.join("\n"),
      totalLines: lines.length,
      offset,
      returnedLines: slice.length,
    };
  }

  #evict() {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      const entry = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      if (entry) {
        try {
          rmSync(entry.path, { force: true });
        } catch {
          // Best effort: a stale temp file is harmless.
        }
      }
    }
  }

  /** Drop everything, including the spilled files. */
  clear() {
    this.#entries.clear();
    try {
      rmSync(this.#directory, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

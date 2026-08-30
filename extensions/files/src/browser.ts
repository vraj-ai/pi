/**
 * Working-tree browsing logic for `/files`.
 *
 * Pure: it reads a directory and produces the rows a picker renders. The
 * navigation rules live here so they can be tested without a terminal, and so
 * "you cannot escape the root" is a property of the model rather than of the UI.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export type RowKind = "up" | "directory" | "file";

export interface BrowserRow {
  readonly kind: RowKind;
  /** Absolute path. For `up`, the parent directory. */
  readonly path: string;
  /** What the picker shows. */
  readonly label: string;
  readonly size?: number;
}

/** Directories that are never worth walking into by hand. */
export const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".turbo",
  "dist",
  "build",
  "target",
  ".DS_Store",
]);

function formatSize(bytes: number) {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)}K`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}M`;
}

/** True when `path` is `root` or lives inside it. Prefix-safe. */
export function isWithin(path: string, root: string) {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(`${base}${sep}`);
}

export interface ListOptions {
  /** Substring filter applied to entry names, case-insensitive. */
  readonly filter?: string;
  /** Show dotfiles and skipped directories. */
  readonly showHidden?: boolean;
  /** Injectable directory read for tests. */
  readonly read?: (directory: string) => Array<{
    name: string;
    isDirectory: boolean;
    size?: number;
  }>;
}

function defaultRead(directory: string) {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    let size: number | undefined;
    if (entry.isFile()) {
      try {
        size = statSync(join(directory, entry.name)).size;
      } catch {
        size = undefined;
      }
    }
    return {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      ...(size === undefined ? {} : { size }),
    };
  });
}

/**
 * Rows for `directory`, directories first then files, each alphabetical. An `up`
 * row is prepended unless `directory` is the root. An unreadable directory
 * yields just the `up` row rather than throwing - a permission-denied folder
 * should not end the browse.
 */
export function listDirectory(
  directory: string,
  root: string,
  options: ListOptions = {},
): BrowserRow[] {
  const here = resolve(directory);
  const base = resolve(root);
  const rows: BrowserRow[] = [];

  if (here !== base && isWithin(here, base)) {
    rows.push({ kind: "up", path: resolve(here, ".."), label: ".." });
  }

  let entries: ReturnType<typeof defaultRead>;
  try {
    entries = (options.read ?? defaultRead)(here);
  } catch {
    return rows;
  }

  const needle = (options.filter ?? "").trim().toLowerCase();
  // Sorting keys off the entry name, not the rendered label: a label carries a
  // size suffix, which would order `a.ts  (1K)` before `a.txt`.
  const directories: Array<{ name: string; row: BrowserRow }> = [];
  const files: Array<{ name: string; row: BrowserRow }> = [];

  for (const entry of entries) {
    if (!options.showHidden) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory && SKIP_DIRECTORIES.has(entry.name)) continue;
    }
    if (needle && !entry.name.toLowerCase().includes(needle)) continue;

    const path = join(here, entry.name);
    if (entry.isDirectory) {
      directories.push({
        name: entry.name,
        row: { kind: "directory", path, label: `${entry.name}/` },
      });
    } else {
      files.push({
        name: entry.name,
        row: {
          kind: "file",
          path,
          label:
            entry.size === undefined
              ? entry.name
              : `${entry.name}  (${formatSize(entry.size)})`,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        },
      });
    }
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  return [
    ...rows,
    ...directories.sort(byName).map((entry) => entry.row),
    ...files.sort(byName).map((entry) => entry.row),
  ];
}

/**
 * Resolve where a row navigates to. Files do not navigate; a row outside the
 * root is refused, so a symlink pointing out of the tree cannot walk the
 * browser into the rest of the filesystem.
 */
export function navigate(
  row: BrowserRow,
  root: string,
): { directory: string } | { file: string } | undefined {
  if (row.kind === "file") {
    return isWithin(row.path, root) ? { file: row.path } : undefined;
  }
  const target = resolve(row.path);
  return isWithin(target, root) ? { directory: target } : undefined;
}

/** The title shown above the picker: the path relative to the root. */
export function browserTitle(directory: string, root: string) {
  const here = resolve(directory);
  const base = resolve(root);
  if (here === base) return basename(base) || base;
  return `${basename(base) || base}/${relative(base, here)}`;
}

/** What `/files` inserts into the editor for a chosen file. */
export function referenceFor(file: string, root: string) {
  const rel = relative(resolve(root), resolve(file));
  return rel && !rel.startsWith("..") ? rel : resolve(file);
}

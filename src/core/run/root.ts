import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Where this checkout's *shared* state lives — the run archive, the budget ledger
 * (D11) and the promoted fixture library.
 *
 * Not `process.cwd()`, and the difference is the whole point. Tasks are executed in
 * git worktrees, and both directories are gitignored, so a cwd-relative answer gives
 * every worktree its **own empty** copy of all three. That produced three failures at
 * once: parser tasks reported their surface's fixture missing when it was sitting in
 * the main checkout, and each worktree spent against a fresh daily ledger, which is a
 * budget cap that silently multiplies by the number of worktrees open — the one thing
 * §8 says must not be bypassable.
 *
 * So the answer is the *main worktree's* root, found from git's own linkage rather
 * than guessed: a linked worktree's `.git` is a file naming its gitdir, that gitdir
 * holds a `commondir` pointing back at the shared `.git`, and that `.git`'s parent is
 * the main checkout. In an ordinary checkout `.git` is a directory and the walk stops
 * there immediately.
 *
 * Overridable by env for tests, which must never write into the real archive.
 */
export const REPO_ROOT_ENV = "LINKEDIN_OS_REPO_ROOT";

/** How far up the tree to look before giving up. Bounded so a path outside any
 *  repository terminates instead of walking to `/` one `existsSync` at a time. */
export const MAX_ROOT_WALK_DEPTH = 24;

/**
 * Resolves the shared-state root, or returns `null` when `from` is not inside a
 * git checkout at all.
 *
 * Pure enough to test: every input is a path, the only I/O is reads, and it never
 * throws — an unreadable or malformed `.git` file is "not a repository", never a
 * crash in the middle of a live capture.
 */
export function findRepoRoot(from: string): string | null {
  let dir = resolve(from);
  for (let depth = 0; depth < MAX_ROOT_WALK_DEPTH; depth += 1) {
    const dotGit = resolve(dir, ".git");
    if (existsSync(dotGit)) {
      const root = rootFromDotGit(dotGit, dir);
      if (root !== null) return root;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** `.git` as a directory means `dir` is the main checkout; as a file it names the
 *  linked worktree's gitdir, from which `commondir` leads back to the main one. */
function rootFromDotGit(dotGit: string, dir: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return dir;
    const gitdirLine = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (gitdirLine === null) return null;
    const raw = gitdirLine[1]!.trim();
    const gitdir = isAbsolute(raw) ? raw : resolve(dir, raw);
    const commondirFile = resolve(gitdir, "commondir");
    if (!existsSync(commondirFile)) return null;
    const commondir = readFileSync(commondirFile, "utf8").trim();
    if (commondir === "") return null;
    // The common dir *is* the shared `.git`; the checkout is its parent.
    return dirname(isAbsolute(commondir) ? commondir : resolve(gitdir, commondir));
  } catch {
    // A `.git` we cannot read is not a repository we can locate state in.
    return null;
  }
}

/**
 * The shared-state root for this process.
 *
 * Falls back to the cwd when nothing above it is a git checkout, because a plain
 * unpacked copy of the toolkit still has to run — it just gets the old behaviour,
 * which is correct when there are no worktrees to disagree about.
 */
export function repoRoot(from: string = process.cwd()): string {
  const override = process.env[REPO_ROOT_ENV];
  if (override !== undefined && override !== "") return resolve(override);
  return findRepoRoot(from) ?? resolve(from);
}

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ROOT_WALK_DEPTH, REPO_ROOT_ENV, findRepoRoot, repoRoot } from "../src/core/run/root.js";

/**
 * Everything here builds a fake checkout on disk rather than pointing at the real
 * one: the bug being pinned is that a *linked worktree* resolves shared state to
 * itself, and that is only reproducible with two directories that disagree.
 */

let sandbox: string;

/** A main checkout: `.git` is a directory. */
function mainCheckout(name: string): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

/** A linked worktree of `main`, wired the way `git worktree add` wires one. */
function linkedWorktree(main: string, name: string, commondir = "../.."): string {
  const gitdir = join(main, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), `${commondir}\n`);
  const root = join(sandbox, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".git"), `gitdir: ${gitdir}\n`);
  return root;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "linkedin-os-root-"));
  delete process.env[REPO_ROOT_ENV];
});

afterEach(() => {
  delete process.env[REPO_ROOT_ENV];
  rmSync(sandbox, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  it("returns the checkout itself when .git is a directory", () => {
    const main = mainCheckout("repo");
    expect(findRepoRoot(main)).toBe(resolve(main));
  });

  it("walks up from a nested directory to the checkout root", () => {
    const main = mainCheckout("repo");
    const nested = join(main, "src", "core", "run");
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(resolve(main));
  });

  it("resolves a linked worktree to the MAIN checkout, not to itself", () => {
    const main = mainCheckout("repo");
    const three = linkedWorktree(main, "three");
    // The regression: this used to answer `three`, giving it an empty fixture
    // library and a private budget ledger.
    expect(findRepoRoot(three)).toBe(resolve(main));
    expect(findRepoRoot(three)).not.toBe(resolve(three));
  });

  it("resolves a linked worktree from a nested directory inside it", () => {
    const main = mainCheckout("repo");
    const three = linkedWorktree(main, "three");
    const nested = join(three, "src", "capabilities");
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(resolve(main));
  });

  it("accepts an absolute commondir", () => {
    const main = mainCheckout("repo");
    const three = linkedWorktree(main, "three", join(main, ".git"));
    expect(findRepoRoot(three)).toBe(resolve(main));
  });

  it("returns null outside any checkout", () => {
    const bare = join(sandbox, "not-a-repo");
    mkdirSync(bare, { recursive: true });
    expect(findRepoRoot(bare)).toBeNull();
  });

  it("returns null for a .git file with no gitdir line", () => {
    const root = join(sandbox, "broken");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".git"), "this is not a gitlink\n");
    expect(findRepoRoot(root)).toBeNull();
  });

  it("returns null for a gitdir that has no commondir", () => {
    const root = join(sandbox, "orphan");
    const gitdir = join(sandbox, "elsewhere");
    mkdirSync(root, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${gitdir}\n`);
    expect(findRepoRoot(root)).toBeNull();
  });

  it("stops walking rather than climbing to the filesystem root forever", () => {
    let deep = join(sandbox, "deep");
    for (let i = 0; i < MAX_ROOT_WALK_DEPTH + 4; i += 1) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBeNull();
  });
});

describe("repoRoot", () => {
  it("prefers the env override over the walk", () => {
    const main = mainCheckout("repo");
    const elsewhere = join(sandbox, "override");
    mkdirSync(elsewhere, { recursive: true });
    process.env[REPO_ROOT_ENV] = elsewhere;
    expect(repoRoot(main)).toBe(resolve(elsewhere));
  });

  it("ignores an empty override", () => {
    const main = mainCheckout("repo");
    process.env[REPO_ROOT_ENV] = "";
    expect(repoRoot(main)).toBe(resolve(main));
  });

  it("falls back to the starting directory outside a checkout", () => {
    const bare = join(sandbox, "loose-copy");
    mkdirSync(bare, { recursive: true });
    expect(repoRoot(bare)).toBe(resolve(bare));
  });
});

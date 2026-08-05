import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Offline half of Task 13's proof. The migration is SQL, so nothing here executes it —
 * these assertions read the file and pin the properties the commit message and STATE.md
 * claim about it. The operational half (applies from scratch, re-applies safely, tables
 * really exist) is `npm run db:verify`, which needs Docker and is not a unit test.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

type SchemaSpec = {
  schema: string;
  tables: Record<string, { columns: string[]; primary_key: string[] }>;
};

const spec = JSON.parse(
  readFileSync(join(process.cwd(), "supabase", "schema.spec.json"), "utf8"),
) as SchemaSpec;

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = migrationFiles
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

/** The body of one `create table if not exists <name> ( ... );` block. */
function tableBody(name: string): string {
  const open = new RegExp(
    `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${name}\\s*\\(`,
    "i",
  );
  const m = open.exec(sql);
  if (!m) throw new Error(`no create table for ${name}`);
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
  }
  return sql.slice(m.index + m[0].length, i - 1);
}

/** Top-level (depth-0) comma-separated items of a create-table body. */
function tableItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

const tableNames = Object.keys(spec.tables);

describe("migration covers spec §7", () => {
  it("declares exactly one migration file", () => {
    expect(migrationFiles).toHaveLength(1);
  });

  it.each(tableNames)("declares table %s", (name) => {
    expect(() => tableBody(name)).not.toThrow();
  });

  it.each(tableNames)("declares every spec column of %s", (name) => {
    const items = tableItems(tableBody(name));
    const declared = items
      .filter((i) => !/^(primary\s+key|unique|constraint|check|foreign\s+key)\b/i.test(i))
      .map((i) => i.split(/\s+/)[0]!.toLowerCase());
    for (const col of spec.tables[name]!.columns) {
      expect(declared, `${name}.${col}`).toContain(col);
    }
  });

  it("declares no table outside the spec list", () => {
    const created = [...sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi)]
      .map((m) => m[1]!);
    expect([...created].sort()).toEqual([...tableNames].sort());
  });
});

describe("re-applying the migration is safe", () => {
  it("guards every create with if not exists", () => {
    const creates = [...sql.matchAll(/^\s*create\s+(?:unique\s+)?(table|index)\s+([\s\S]*?)$/gim)];
    expect(creates.length).toBeGreaterThan(0);
    for (const m of creates) {
      expect(m[0].toLowerCase(), m[0].slice(0, 90)).toContain("if not exists");
    }
  });

  it("uses no bare drop, truncate or delete", () => {
    expect(sql).not.toMatch(/\b(drop|truncate)\s+table\b/i);
    expect(sql).not.toMatch(/^\s*delete\s+from\b/im);
  });
});

describe("identity is LinkedIn's own URN", () => {
  it("keys every entity table on its urn, never a surrogate", () => {
    for (const t of ["persons", "companies", "person_posts", "company_posts"]) {
      expect(spec.tables[t]!.primary_key, t).toEqual(["urn"]);
      expect(tableBody(t)).toMatch(/urn\s+text\s+primary\s+key/i);
    }
  });

  it("gives every entity table first_seen/last_seen or a discovered_at", () => {
    for (const t of ["persons", "companies"]) {
      const body = tableBody(t);
      expect(body, t).toMatch(/first_seen/);
      expect(body, t).toMatch(/last_seen/);
    }
  });

  it("indexes last_seen so --max-age freshness lookups are not seq scans", () => {
    for (const t of ["persons", "companies"]) {
      expect(sql, t).toMatch(new RegExp(`on\\s+public\\.${t}\\s*\\(last_seen`, "i"));
    }
  });

  it("declares search_results append-only: no unique key over its natural columns", () => {
    const body = tableBody("search_results");
    expect(body).not.toMatch(/unique/i);
    expect(sql).not.toMatch(/create\s+unique\s+index[^;]*on\s+public\.search_results/i);
  });
});

describe("foreign keys only where they cannot lie", () => {
  it("references runs and searches, the two parents we create ourselves", () => {
    expect(tableBody("raw_captures")).toMatch(/references\s+public\.runs\s*\(run_id\)/i);
    expect(tableBody("search_results")).toMatch(/references\s+public\.searches\s*\(search_id\)/i);
  });

  it("puts no foreign key on any LinkedIn URN column", () => {
    for (const name of tableNames) {
      for (const item of tableItems(tableBody(name))) {
        if (!/references/i.test(item)) continue;
        expect(item, `${name}: ${item}`).not.toMatch(/_urn\b[\s\S]*references/i);
      }
    }
  });
});

describe("exposure is explicit and denies by default", () => {
  it.each(tableNames)("enables row level security on %s", (name) => {
    expect(sql).toMatch(
      new RegExp(`alter\\s+table\\s+public\\.${name}\\s+enable\\s+row\\s+level\\s+security`, "i"),
    );
  });

  it("creates no policy, so only the service role reaches the data", () => {
    expect(sql).not.toMatch(/create\s+policy/i);
  });

  it("grants to service_role and to nobody else", () => {
    const grants = [...sql.matchAll(/grant\s+[\s\S]*?\s+to\s+([\w,\s]+);/gi)].map((m) => m[1]!);
    expect(grants.length).toBeGreaterThan(0);
    for (const to of grants) {
      expect(to.trim()).toBe("service_role");
    }
    expect(sql).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });
});

describe("the budget ledger table is labelled a mirror", () => {
  it("carries a comment saying the file is the source of truth (D11)", () => {
    const m = /comment\s+on\s+table\s+public\.budget_ledger\s+is\s+'([\s\S]*?)';/i.exec(sql);
    expect(m, "budget_ledger has no table comment").not.toBeNull();
    const comment = m![1]!;
    expect(comment.toLowerCase()).toContain("mirror");
    expect(comment).toContain("runs/budget.ndjson");
  });
});

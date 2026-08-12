import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260812180000_lead_pipeline.sql", "utf8");

describe("lead_pipeline migration", () => {
  it("creates the table idempotently", () => {
    expect(sql).toMatch(/create table if not exists public\.lead_pipeline/);
  });
  it("constrains status to the seven pipeline values", () => {
    for (const s of ["new", "enriched", "contacted", "replied", "won", "lost", "skipped"]) {
      expect(sql).toContain(`'${s}'`);
    }
  });
  it("enables row level security", () => {
    expect(sql).toMatch(/alter table public\.lead_pipeline enable row level security/);
  });
  it("never drops or rewrites", () => {
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b/i);
  });
});

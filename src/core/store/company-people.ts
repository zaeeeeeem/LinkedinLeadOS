import { getStore, storeError } from "./client.js";
import { TABLES } from "./constants.js";
import { StoreWriteError, type StoreOpts } from "./persons.js";
import type { CompanyPeopleUpsertResult, CompanyPersonInput } from "./types.js";

/** One atomic, pair-deduplicated batch. discovered_at remains database-owned. */
export async function upsertCompanyPeople(people: readonly CompanyPersonInput[], opts: StoreOpts = {}): Promise<CompanyPeopleUpsertResult> {
  const unique = [...new Map(people.map((row) => [`${row.company_urn}\0${row.person_urn}`, row])).values()];
  if (unique.length === 0) return { rows: 0 };
  const client = opts.client ?? getStore();
  const result = await client.from(TABLES.companyPeople).upsert(unique, { onConflict: "company_urn,person_urn" }).select("company_urn,person_urn");
  if (result.error) throw new StoreWriteError(storeError({ op: "upsert company people", table: TABLES.companyPeople, kind: "write", status: result.status, cause: result.error }), 0);
  return { rows: result.data?.length ?? unique.length };
}

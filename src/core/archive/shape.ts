import { createHash } from "node:crypto";

/**
 * Structural fingerprint of a JSON value: key paths and value *types*, never
 * values. Two responses describing different people collide deliberately —
 * that collision is the feature. It is what lets fixture promotion keep one
 * body per distinct shape, and what lets drift detection notice the day
 * LinkedIn renames a field or turns a string into an object.
 *
 * Rules, all pinned by tests:
 *  - key order is irrelevant (object keys are sorted);
 *  - adding or removing a key changes the shape;
 *  - a value changing type changes the shape;
 *  - an array collapses to the union of its element shapes, so a 1-item and a
 *    100-item list of the same element shape are identical;
 *  - `null` is its own type, distinct from a string, a number, or a missing key.
 *
 * The input must be JSON-derived (`JSON.parse` output or an equivalent plain
 * value). Cyclic graphs are not a thing a response body can be.
 */
export function canonicalShape(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      return "num";
    case "string":
      return "str";
  }
  if (Array.isArray(value)) {
    // Distinct element shapes, sorted: length carries no structure, and a
    // heterogeneous list is the same list whichever order it arrived in.
    const members = [...new Set(value.map(canonicalShape))].sort();
    return `[${members.join("|")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalShape((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  // `undefined`, functions, symbols: not reachable from JSON.parse, but the
  // function stays total rather than throwing on a hand-built object.
  return "unknown";
}

/** The canonical form of a body that is not JSON at all — an HTML error page,
 *  a redirect stub, an image. It still gets archived; it just has no shape. */
export const NON_JSON_SHAPE = "<non-json>";

/** Hash length in hex characters. Long enough that two genuinely different
 *  shapes never share a fixture filename, short enough to read in a path. */
const HASH_CHARS = 16;

function digest(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, HASH_CHARS);
}

/** Shape fingerprint of an already-parsed JSON value. */
export function shapeHash(value: unknown): string {
  return digest(canonicalShape(value));
}

/**
 * Shape fingerprint of a raw response body. A body that does not parse as JSON
 * is not an error here — the archive's job is to keep it regardless — it just
 * hashes to the single non-JSON shape.
 */
export function shapeHashOfBody(body: string | Uint8Array): string {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  try {
    return digest(canonicalShape(JSON.parse(text)));
  } catch {
    return digest(NON_JSON_SHAPE);
  }
}

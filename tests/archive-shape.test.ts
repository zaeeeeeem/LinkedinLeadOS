import { describe, it, expect } from "vitest";
import { canonicalShape, shapeHash, shapeHashOfBody } from "../src/core/archive/shape.js";

describe("canonicalShape / shapeHash", () => {
  it("collides deliberately: same structure, different values", () => {
    const a = { name: "Alice", age: 30, active: true };
    const b = { name: "Bob", age: 41, active: false };
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it("is indifferent to key order", () => {
    const a = { x: 1, y: "two", z: null };
    const b = { z: null, x: 1, y: "two" };
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it("changes when a key is added", () => {
    const base = { name: "Alice" };
    const withExtra = { name: "Alice", age: 30 };
    expect(shapeHash(base)).not.toBe(shapeHash(withExtra));
  });

  it("changes when a key is removed", () => {
    const full = { name: "Alice", age: 30 };
    const stripped = { name: "Alice" };
    expect(shapeHash(full)).not.toBe(shapeHash(stripped));
  });

  it("changes when a value's type changes: string to number", () => {
    expect(shapeHash({ id: "123" })).not.toBe(shapeHash({ id: 123 }));
  });

  it("changes when a value's type changes: string to null", () => {
    expect(shapeHash({ id: "123" })).not.toBe(shapeHash({ id: null }));
  });

  it("changes when a value's type changes: object to array", () => {
    expect(shapeHash({ list: { a: 1 } })).not.toBe(shapeHash({ list: [1] }));
  });

  it("hashes a 1-item and a 100-item array of the same element shape identically", () => {
    const one = [{ id: 1, name: "a" }];
    const hundred = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `n${i}` }));
    expect(shapeHash(one)).toBe(shapeHash(hundred));
  });

  it("differs between a homogeneous array and one with a differently-shaped element", () => {
    const homogeneous = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const heterogeneous = [{ id: 1 }, { id: 2 }, { id: "three" }];
    expect(shapeHash(homogeneous)).not.toBe(shapeHash(heterogeneous));
  });

  it("is indifferent to element order within a heterogeneous array", () => {
    const a = [{ id: 1 }, "two", 3];
    const b = [3, { id: 1 }, "two"];
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it("treats an empty array as its own shape, distinct from [num]", () => {
    expect(shapeHash([])).not.toBe(shapeHash([1]));
  });

  it("treats null as its own type, distinct from a string or a missing key", () => {
    const withNull = { a: null };
    const withString = { a: "x" };
    const withoutKey = {};
    expect(shapeHash(withNull)).not.toBe(shapeHash(withString));
    expect(shapeHash(withNull)).not.toBe(shapeHash(withoutKey));
    expect(shapeHash(withString)).not.toBe(shapeHash(withoutKey));
  });

  it("applies every rule through nested objects inside arrays inside objects", () => {
    const a = {
      results: [
        { profile: { name: "Alice", tags: ["a", "b"] } },
        { profile: { name: "Bob", tags: ["c"] } },
      ],
    };
    // Same shape, different values and different array lengths at every level.
    const b = {
      results: [
        { profile: { name: "Zara", tags: ["x", "y", "z"] } },
      ],
    };
    expect(shapeHash(a)).toBe(shapeHash(b));

    // Now break the shape one level down: a tag becomes a number.
    const c = {
      results: [{ profile: { name: "Alice", tags: [1, "b"] } }],
    };
    expect(shapeHash(a)).not.toBe(shapeHash(c));

    // And break it by adding a key inside the nested object.
    const d = {
      results: [{ profile: { name: "Alice", tags: ["a"], id: 7 } }],
    };
    expect(shapeHash(a)).not.toBe(shapeHash(d));
  });

  it("canonicalShape produces a stable, sorted-key string form", () => {
    expect(canonicalShape({ b: 1, a: "x" })).toBe('{"a":str,"b":num}');
    expect(canonicalShape([1, 2, 3])).toBe("[num]");
    expect(canonicalShape([])).toBe("[]");
    expect(canonicalShape(null)).toBe("null");
  });
});

describe("shapeHashOfBody", () => {
  it("parses JSON and matches shapeHash of the parsed value", () => {
    const body = JSON.stringify({ name: "Alice", age: 30 });
    expect(shapeHashOfBody(body)).toBe(shapeHash({ name: "Alice", age: 30 }));
  });

  it("accepts a Uint8Array body the same as the equivalent string", () => {
    const text = JSON.stringify({ ok: true });
    const bytes = new TextEncoder().encode(text);
    expect(shapeHashOfBody(bytes)).toBe(shapeHashOfBody(text));
  });

  it("hashes a non-JSON body to a stable non-JSON shape without throwing, distinct from any JSON shape", () => {
    expect(() => shapeHashOfBody("<html>not json</html>")).not.toThrow();
    // Every non-JSON body collapses to the same fingerprint...
    expect(shapeHashOfBody("plain text")).toBe(shapeHashOfBody("<xml>also not json</xml>"));
    // ...and that fingerprint is not indistinguishable from a real JSON shape,
    // in particular not from the shape a literal JSON string would produce.
    expect(shapeHashOfBody("<html>not json</html>")).not.toBe(shapeHash("some string"));
  });
});

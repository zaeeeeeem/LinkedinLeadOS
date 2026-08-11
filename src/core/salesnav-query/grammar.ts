export type QueryAtom = { kind: "atom"; value: string };
export type QueryList = { kind: "list"; items: QueryValue[] };
export type QueryEntry = { key: string; value: QueryValue };
export type QueryObject = { kind: "object"; entries: QueryEntry[] };
export type QueryValue = QueryAtom | QueryList | QueryObject;

const KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

export class SalesNavQuerySyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "SalesNavQuerySyntaxError";
    this.offset = offset;
  }
}

/** RFC3986 component encoding with the five characters JavaScript leaves
 * unescaped but the measured Rest.li grammar uses structurally. */
export function encodeQueryAtom(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function atom(value: string): QueryAtom {
  return { kind: "atom", value };
}

export function list(items: QueryValue[]): QueryList {
  return { kind: "list", items };
}

export function object(entries: QueryEntry[]): QueryObject {
  return { kind: "object", entries };
}

class Parser {
  #offset = 0;

  constructor(private readonly input: string) {}

  parse(): QueryObject {
    const value = this.parseObject();
    if (this.#offset !== this.input.length) this.fail("unexpected trailing input");
    return value;
  }

  private parseValue(): QueryValue {
    if (this.input.startsWith("List(", this.#offset)) return this.parseList();
    if (this.peek() === "(") return this.parseObject();
    return this.parseAtom();
  }

  private parseObject(): QueryObject {
    this.expect("(");
    const entries: QueryEntry[] = [];
    if (this.peek() === ")") this.fail("objects must contain at least one entry");
    for (;;) {
      const key = this.parseKey();
      this.expect(":");
      entries.push({ key, value: this.parseValue() });
      if (this.peek() === ")") {
        this.#offset++;
        return object(entries);
      }
      this.expect(",");
      if (this.peek() === ")") this.fail("trailing comma is not allowed");
    }
  }

  private parseList(): QueryList {
    this.#offset += "List(".length;
    const items: QueryValue[] = [];
    if (this.peek() === ")") {
      this.#offset++;
      return list(items);
    }
    for (;;) {
      items.push(this.parseValue());
      if (this.peek() === ")") {
        this.#offset++;
        return list(items);
      }
      this.expect(",");
      if (this.peek() === ")") this.fail("trailing comma is not allowed");
    }
  }

  private parseKey(): string {
    const start = this.#offset;
    while (/[A-Za-z0-9_]/.test(this.peek() ?? "")) this.#offset++;
    const key = this.input.slice(start, this.#offset);
    if (!KEY.test(key)) this.fail("expected an unencoded field name", start);
    return key;
  }

  private parseAtom(): QueryAtom {
    const start = this.#offset;
    while (this.#offset < this.input.length && !",)".includes(this.input[this.#offset]!)) {
      const char = this.input[this.#offset]!;
      if (char === "(" || char === ":" || /\s/.test(char)) {
        this.fail(`unescaped ${JSON.stringify(char)} in atom`);
      }
      this.#offset++;
    }
    if (this.#offset === start) this.fail("empty atom");
    const encoded = this.input.slice(start, this.#offset);
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      this.fail("malformed percent escape", start);
    }
    return atom(value!);
  }

  private peek(): string | undefined {
    return this.input[this.#offset];
  }

  private expect(expected: string): void {
    if (!this.input.startsWith(expected, this.#offset)) this.fail(`expected ${JSON.stringify(expected)}`);
    this.#offset += expected.length;
  }

  private fail(message: string, offset = this.#offset): never {
    throw new SalesNavQuerySyntaxError(message, offset);
  }
}

export function parseSalesNavQuery(input: string): QueryObject {
  if (input.length === 0) throw new SalesNavQuerySyntaxError("query is empty", 0);
  return new Parser(input).parse();
}

export function serializeSalesNavQuery(value: QueryValue): string {
  if (value.kind === "atom") return encodeQueryAtom(value.value);
  if (value.kind === "list") return `List(${value.items.map(serializeSalesNavQuery).join(",")})`;
  return `(${value.entries.map(({ key, value: child }) => {
    if (!KEY.test(key)) throw new SalesNavQuerySyntaxError(`invalid field name ${JSON.stringify(key)}`, 0);
    return `${key}:${serializeSalesNavQuery(child)}`;
  }).join(",")})`;
}

export function rawUrlParam(url: string, name: string): string | null {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return null;
  const fragmentStart = url.indexOf("#", queryStart);
  const query = url.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key: string;
    try { key = decodeURIComponent(rawKey); } catch { continue; }
    if (key === name) return eq === -1 ? "" : part.slice(eq + 1);
  }
  return null;
}

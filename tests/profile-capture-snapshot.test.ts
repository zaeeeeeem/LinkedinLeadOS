import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOM_SNAPSHOT_PATTERN,
  SIDEBAR_SELECTORS,
  SNAPSHOT_EXPRESSION,
  SUBJECT_CONTAINER_SELECTORS,
  captureDomSnapshot,
  domSnapshotUrl,
  interpretSnapshot,
  isDomSnapshotEntry,
  isSubjectRendered,
} from "../src/capabilities/profile.capture/snapshot.js";
import type {
  SnapshotArchive, SnapshotProbe, SnapshotTab,
} from "../src/capabilities/profile.capture/snapshot.js";
import {
  SUBJECT_CONTAINER_MIN_SECTIONS, SUBJECT_CONTAINER_MIN_TEXT,
} from "../src/capabilities/profile.capture/constants.js";
import { RawArchive } from "../src/core/archive/raw.js";
import type { WorkerTab } from "../src/core/session/tab.js";

/** Compile-time: the real tab and the real archive satisfy what the snapshot
 *  step asks for. This is the first place `WorkerTab` and `RawArchive` are used
 *  together outside the runner (CONTEXT §4). Verified to fail when either
 *  member is renamed. */
const _tabComposes: SnapshotTab = null as unknown as WorkerTab;
const _archiveComposes: SnapshotArchive = null as unknown as RawArchive;
void [_tabComposes, _archiveComposes];

// ---------------------------------------------------------------------------
// The in-page expression, executed as real JavaScript against a stub document.
// A hand-written "what it probably returns" object would certify the shape this
// module expects rather than the shape the page produces.
// ---------------------------------------------------------------------------

type StubEl = {
  outerHTML: string;
  innerText?: string;
  textContent?: string;
  /** selector → how many nodes inside this element match it. */
  inside: Record<string, number>;
};

function stubEl(o: Partial<StubEl> & { outerHTML: string }): StubEl {
  return { inside: {}, ...o };
}

function elementQuery(el: StubEl) {
  return (sel: string): unknown[] => {
    // The expression joins the sidebar selectors with a comma, exactly as a
    // real querySelectorAll takes them; the stub has to split them back.
    const total = sel
      .split(",")
      .map((s) => s.trim())
      .reduce((n, s) => n + (el.inside[s] ?? 0), 0);
    return new Array<unknown>(total).fill({});
  };
}

function evalSnapshot(doc: {
  html: string;
  href?: string;
  body?: StubEl | null;
  /** Selector → the element it resolves to, in document order of preference. */
  containers?: Record<string, StubEl>;
  /** selector → how many nodes in the whole document match it. */
  documentMatches?: Record<string, number>;
}): SnapshotProbe | null {
  const containers = doc.containers ?? {};
  const documentMatches = doc.documentMatches ?? {};
  const documentEl = stubEl({ outerHTML: doc.html });

  const document = {
    documentElement: {
      outerHTML: documentEl.outerHTML,
    },
    body: doc.body === undefined ? stubEl({ outerHTML: doc.html, innerText: "" }) : doc.body,
    location: { href: doc.href ?? "https://www.linkedin.com/in/subject/" },
    querySelector: (sel: string) => containers[sel] ?? null,
    querySelectorAll: (sel: string) => {
      const total = sel
        .split(",")
        .map((s) => s.trim())
        .reduce((n, s) => n + (documentMatches[s] ?? 0), 0);
      return new Array<unknown>(total).fill({});
    },
  };

  // The stub elements need their own querySelectorAll; attach it lazily so the
  // fixtures above stay plain data.
  for (const el of Object.values(containers)) {
    (el as unknown as Record<string, unknown>)["querySelectorAll"] = elementQuery(el);
  }

  const fn = new Function("document", `return (${SNAPSHOT_EXPRESSION});`) as (
    d: unknown,
  ) => SnapshotProbe | null;
  return fn(document);
}

describe("SNAPSHOT_EXPRESSION — run as real JS against a stub document", () => {
  const RENDERED = () =>
    evalSnapshot({
      html: "<html><body>…</body></html>",
      body: stubEl({ outerHTML: "<body>", innerText: "x".repeat(30_963) }),
      containers: {
        "main#workspace": stubEl({
          outerHTML: "<main id=workspace>…</main>",
          innerText: "y".repeat(9_000),
          inside: { section: 14 },
        }),
      },
      documentMatches: { aside: 3 },
    });

  it("returns the whole document plus the subject container's measurements", () => {
    const r = RENDERED();
    expect(r).not.toBeNull();
    expect(r!.html).toBe("<html><body>…</body></html>");
    expect(r!.url).toBe("https://www.linkedin.com/in/subject/");
    expect(r!.htmlChars).toBe("<html><body>…</body></html>".length);
    expect(r!.textChars).toBe(30_963);
    expect(r!.container).toEqual({
      selector: "main#workspace",
      chars: "<main id=workspace>…</main>".length,
      textChars: 9_000,
      sections: 14,
      sidebars: 3,
      sidebarsInside: 0,
    });
  });

  it("prefers main#workspace and falls back through the rest in order", () => {
    // D115 measured `main#workspace` as the real container. The fallbacks exist
    // so a layout change degrades to a wider container, not to nothing.
    expect(SUBJECT_CONTAINER_SELECTORS).toEqual(["main#workspace", "main", "[role=main]"]);

    const both = evalSnapshot({
      html: "<html>",
      containers: {
        "main#workspace": stubEl({ outerHTML: "<main id=workspace>", innerText: "a" }),
        main: stubEl({ outerHTML: "<main>", innerText: "bbbb" }),
      },
    });
    expect(both!.container.selector).toBe("main#workspace");

    const onlyGeneric = evalSnapshot({
      html: "<html>",
      containers: { main: stubEl({ outerHTML: "<main>", innerText: "bbbb" }) },
    });
    expect(onlyGeneric!.container.selector).toBe("main");

    const onlyRole = evalSnapshot({
      html: "<html>",
      containers: { "[role=main]": stubEl({ outerHTML: "<div role=main>", innerText: "c" }) },
    });
    expect(onlyRole!.container.selector).toBe("[role=main]");
  });

  it("reports a container that was never found instead of throwing", () => {
    const r = evalSnapshot({ html: "<html><body></body></html>", containers: {} });
    expect(r).not.toBeNull();
    expect(r!.container.selector).toBeNull();
    expect(r!.container.chars).toBe(0);
    expect(r!.container.sections).toBe(0);
  });

  it("counts sidebars inside the subject container separately from the page's", () => {
    // Container scoping is the property that makes the DOM usable where the RSC
    // flight tree was not (D123). A sidebar inside the container defeats it.
    const r = evalSnapshot({
      html: "<html>",
      containers: {
        "main#workspace": stubEl({
          outerHTML: "<main>",
          innerText: "z".repeat(1_000),
          inside: { section: 9, aside: 2 },
        }),
      },
      documentMatches: { aside: 4, "[role=complementary]": 1 },
    });
    expect(r!.container.sidebars).toBe(5);
    expect(r!.container.sidebarsInside).toBe(2);
    expect(SIDEBAR_SELECTORS).toEqual(["aside", "[role=complementary]"]);
  });

  it("falls back to textContent when innerText is absent, and to 0 when both are", () => {
    const viaTextContent = evalSnapshot({
      html: "<html>",
      body: stubEl({ outerHTML: "<body>", textContent: "abc" }),
      containers: { main: stubEl({ outerHTML: "<main>", textContent: "de" }) },
    });
    expect(viaTextContent!.textChars).toBe(3);
    expect(viaTextContent!.container.textChars).toBe(2);

    const neither = evalSnapshot({
      html: "<html>",
      body: stubEl({ outerHTML: "<body>" }),
      containers: {},
    });
    expect(neither!.textChars).toBe(0);
  });

  it("returns null rather than throwing when the page cannot be read", () => {
    const fn = new Function("document", `return (${SNAPSHOT_EXPRESSION});`) as (
      d: unknown,
    ) => unknown;
    // A document whose querySelector throws — a torn-down execution context, or
    // a page that replaced the DOM API. The listener above must not see a throw.
    expect(
      fn({
        documentElement: { outerHTML: "<html>" },
        querySelector: () => {
          throw new Error("dead context");
        },
      }),
    ).toBeNull();
    // No documentElement at all.
    expect(fn({ documentElement: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// interpretSnapshot / isSubjectRendered — the pure half.
// ---------------------------------------------------------------------------

describe("interpretSnapshot", () => {
  it("rejects anything without html, so an empty snapshot never becomes a fixture", () => {
    expect(interpretSnapshot(null)).toBeNull();
    expect(interpretSnapshot("<html>")).toBeNull();
    expect(interpretSnapshot({})).toBeNull();
    expect(interpretSnapshot({ html: "" })).toBeNull();
  });

  it("defaults every measurement it did not get, rather than trusting a partial", () => {
    const r = interpretSnapshot({ html: "<html>" });
    expect(r).toEqual({
      html: "<html>",
      url: "",
      htmlChars: 6,
      textChars: 0,
      container: { selector: null, chars: 0, textChars: 0, sections: 0, sidebars: 0, sidebarsInside: 0 },
    });
  });

  it("discards non-finite numbers instead of carrying NaN onto the receipt", () => {
    const r = interpretSnapshot({
      html: "<html>",
      textChars: Number.NaN,
      container: { selector: "main", textChars: Number.POSITIVE_INFINITY, sections: 3 },
    });
    expect(r!.textChars).toBe(0);
    expect(r!.container.textChars).toBe(0);
    expect(r!.container.sections).toBe(3);
  });
});

describe("isSubjectRendered", () => {
  const base = { selector: "main#workspace", chars: 1, sidebars: 0, sidebarsInside: 0 };

  it("needs a container, text, and sections — the shell alone is not rendered", () => {
    // LinkedIn mounts main#workspace before it fills it (D115), so "the
    // container exists" alone certifies an empty page as a fixture.
    expect(isSubjectRendered({ ...base, textChars: 20_000, sections: 14 })).toBe(true);
    expect(isSubjectRendered({ ...base, selector: null, textChars: 20_000, sections: 14 })).toBe(false);
    expect(isSubjectRendered({ ...base, textChars: 0, sections: 14 })).toBe(false);
    expect(isSubjectRendered({ ...base, textChars: 20_000, sections: 0 })).toBe(false);
  });

  it("trips exactly at each floor and not one character earlier", () => {
    expect(
      isSubjectRendered({ ...base, textChars: SUBJECT_CONTAINER_MIN_TEXT - 1, sections: SUBJECT_CONTAINER_MIN_SECTIONS }),
    ).toBe(false);
    expect(
      isSubjectRendered({ ...base, textChars: SUBJECT_CONTAINER_MIN_TEXT, sections: SUBJECT_CONTAINER_MIN_SECTIONS }),
    ).toBe(true);
    expect(
      isSubjectRendered({ ...base, textChars: SUBJECT_CONTAINER_MIN_TEXT, sections: SUBJECT_CONTAINER_MIN_SECTIONS - 1 }),
    ).toBe(false);
  });
});

describe("domSnapshotUrl / isDomSnapshotEntry", () => {
  it("marks the snapshot as something no server sent", () => {
    expect(domSnapshotUrl("https://www.linkedin.com/in/x/")).toBe(
      "dom-snapshot:https://www.linkedin.com/in/x/",
    );
  });

  it("recognises a snapshot by its sidecar pattern, and by url when the sidecar is gone", () => {
    // A sidecar write can fail on its own (ARCHIVE_SIDECAR_FAILED, D31) without
    // the body being lost — promotion must still recognise what it is looking at.
    expect(isDomSnapshotEntry({ url: "dom-snapshot:https://x/", pattern: DOM_SNAPSHOT_PATTERN })).toBe(true);
    expect(isDomSnapshotEntry({ url: "dom-snapshot:https://x/" })).toBe(true);
    expect(isDomSnapshotEntry({ url: "https://www.linkedin.com/voyager/api/me" })).toBe(false);
    expect(isDomSnapshotEntry({ url: "", pattern: "gql-any" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// captureDomSnapshot — against the real RawArchive, in a temp directory.
// ---------------------------------------------------------------------------

function fakeTab(answer: unknown | Error): SnapshotTab & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async evaluate<T>(expression: string): Promise<T> {
      calls.push(expression);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
}

const GOOD_PROBE = {
  html: "<html><main id=workspace>content</main></html>",
  url: "https://www.linkedin.com/in/subject/",
  htmlChars: 45,
  textChars: 5_000,
  container: { selector: "main#workspace", chars: 40, textChars: 4_000, sections: 12, sidebars: 3, sidebarsInside: 0 },
};

describe("captureDomSnapshot", () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "snapshot-"));
  }

  it("archives the html raw-first and marks it as a DOM read, not a response", async () => {
    const dir = tempDir();
    try {
      const archive = new RawArchive(dir);
      const tab = fakeTab(GOOD_PROBE);
      const r = await captureDomSnapshot({
        tab, archive, targetUrl: "https://www.linkedin.com/in/subject/",
      });

      expect(r.failure).toBeNull();
      expect(r.rendered).toBe(true);
      expect(r.archived).not.toBeNull();

      // One DOM read, and it is the snapshot expression — nothing else.
      expect(tab.calls).toEqual([SNAPSHOT_EXPRESSION]);

      // Byte-identical on disk, gzipped like every other body (D2).
      const back = await archive.readText(r.archived!);
      expect(back).toBe(GOOD_PROBE.html);

      const listed = await archive.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.pattern).toBe(DOM_SNAPSHOT_PATTERN);
      expect(listed[0]!.url).toBe("dom-snapshot:https://www.linkedin.com/in/subject/");
      expect(listed[0]!.method).toBe("DOM");
      // `status: 0` — no server answered this. A snapshot recorded as 200 would
      // be indistinguishable from a body LinkedIn actually served.
      expect(listed[0]!.status).toBe(0);
      expect(listed[0]!.contentType).toBe("text/html; charset=utf-8");
      expect(isDomSnapshotEntry(listed[0]!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archives a half-rendered page too, and says so", async () => {
    // The not-rendered branch. The snapshot is evidence about the page; dropping
    // it would leave the warning with nothing behind it.
    const dir = tempDir();
    try {
      const archive = new RawArchive(dir);
      const r = await captureDomSnapshot({
        tab: fakeTab({
          ...GOOD_PROBE,
          html: "<html><main id=workspace></main></html>",
          container: { ...GOOD_PROBE.container, textChars: 12, sections: 0 },
        }),
        archive,
        targetUrl: "https://www.linkedin.com/in/subject/",
      });

      expect(r.rendered).toBe(false);
      expect(r.failure).toBeNull();
      expect(r.archived).not.toBeNull();
      expect(readdirSync(dir).filter((f) => f.endsWith(".json.gz"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a page that would not answer as probe-failed, without throwing", async () => {
    const dir = tempDir();
    try {
      const r = await captureDomSnapshot({
        tab: fakeTab(new Error("TAB_EVAL_FAILED: page JS threw")),
        archive: new RawArchive(dir),
        targetUrl: "https://www.linkedin.com/in/subject/",
      });
      expect(r.failure).toBe("probe-failed");
      expect(r.archived).toBeNull();
      expect(r.rendered).toBe(false);
      expect(r.detail).toContain("TAB_EVAL_FAILED");
      // Nothing was written: there was nothing to write.
      expect(readdirSync(dir).filter((f) => f.endsWith(".json.gz"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a null probe as probe-failed rather than archiving an empty fixture", async () => {
    const dir = tempDir();
    try {
      const r = await captureDomSnapshot({
        tab: fakeTab(null),
        archive: new RawArchive(dir),
        targetUrl: "https://www.linkedin.com/in/subject/",
      });
      expect(r.failure).toBe("probe-failed");
      expect(r.detail).toContain("no serializable document");
      expect(readdirSync(dir).filter((f) => f.endsWith(".json.gz"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits an archive failure from a probe failure — they send an operator to different places", async () => {
    const failing: SnapshotArchive = {
      async archive() {
        throw new Error("ARCHIVE_WRITE_FAILED: ENOSPC");
      },
    };
    const r = await captureDomSnapshot({
      tab: fakeTab(GOOD_PROBE),
      archive: failing,
      targetUrl: "https://www.linkedin.com/in/subject/",
    });
    expect(r.failure).toBe("archive-failed");
    expect(r.archived).toBeNull();
    // The measurements survive: the page *did* render, and the receipt should
    // not also claim it did not.
    expect(r.rendered).toBe(true);
    expect(r.probe).not.toBeNull();
    expect(r.detail).toContain("ENOSPC");
  });

  it("never puts the captured html on the failure detail", async () => {
    const failing: SnapshotArchive = {
      async archive() {
        throw new Error("disk full");
      },
    };
    const r = await captureDomSnapshot({
      tab: fakeTab(GOOD_PROBE),
      archive: failing,
      targetUrl: "https://www.linkedin.com/in/subject/",
    });
    expect(r.detail).not.toContain("content");
    expect(r.detail).toBe("disk full");
  });
});

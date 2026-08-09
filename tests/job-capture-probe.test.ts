import { describe, expect, it } from "vitest";
import {
  CLAMP_SLACK_PX,
  EXPANDER_EXPRESSION,
  MAX_ELEMENTS,
  descriptionVerdict,
  interpretExpanderProbe,
  measureExpander,
} from "../src/capabilities/job.capture/probe.js";
import type { ExpanderProbe } from "../src/capabilities/job.capture/probe.js";

/** One element as the expression sees it. */
type StubEl = {
  tagName: string;
  textContent: string;
  clientHeight: number;
  scrollHeight: number;
  childElementCount: number;
  id?: string;
  attrs?: Record<string, string>;
  style?: { overflowY?: string; overflow?: string; webkitLineClamp?: string };
};

function el(o: Partial<StubEl> & { tagName: string; textContent: string }): StubEl {
  return {
    clientHeight: 20, scrollHeight: 20, childElementCount: 0, attrs: {}, style: {}, ...o,
  };
}

/** Runs the expression the way Chrome does, against a stub page. The expression
 *  is a string, so nothing else in this repo type-checks it. */
function evaluateAgainst(elements: StubEl[], bodyText = "body text"): unknown {
  const nodes = elements.map((e) => ({
    ...e,
    id: e.id ?? "",
    getAttribute: (name: string) => e.attrs?.[name] ?? null,
  }));
  const document = {
    querySelectorAll: () => nodes,
    body: { textContent: bodyText },
  };
  const getComputedStyle = (node: { style?: StubEl["style"] }) => node.style ?? {};
  return new Function("document", "getComputedStyle", `return (${EXPANDER_EXPRESSION});`)(
    document,
    getComputedStyle,
  );
}

const DESCRIPTION = "x".repeat(4_000);

describe("EXPANDER_EXPRESSION, executed as real javascript", () => {
  it("finds a clamped description with a see-more control, and calls it a DOM toggle", () => {
    // The shape that means the whole description is already in the archived
    // snapshot: the text is there, the box is short, the overflow is hidden.
    const raw = evaluateAgainst([
      el({ tagName: "DIV", textContent: "layout", childElementCount: 30, scrollHeight: 4000, clientHeight: 800 }),
      el({
        tagName: "DIV", textContent: DESCRIPTION, childElementCount: 2,
        clientHeight: 300, scrollHeight: 2_400,
        style: { overflowY: "hidden" },
        attrs: { componentkey: "com.linkedin.sdui.jobs.description" },
      }),
      el({ tagName: "BUTTON", textContent: "See more", attrs: { role: "button" } }),
    ]);

    const probe = interpretExpanderProbe(raw)!;
    expect(probe.seeMoreControls).toBe(1);
    expect(probe.clampedBlocks).toBe(1);
    expect(probe.largest!.chars).toBe(4_000);
    expect(probe.largest!.componentkey).toBe("com.linkedin.sdui.jobs.description");
    expect(probe.largest!.clamped).toBe(true);
    expect(probe.truncated).toBe(false);
    expect(descriptionVerdict(probe)).toBe("dom-toggle");
  });

  it("calls a short ellipsised block behind a control a likely request", () => {
    // The opposite shape: what is rendered is all the DOM has, and the rest
    // arrives only if something asks for it.
    const raw = evaluateAgainst([
      el({ tagName: "DIV", textContent: `${"y".repeat(300)}…`, clientHeight: 200, scrollHeight: 200 }),
      el({ tagName: "A", textContent: "Show more" }),
    ]);
    const probe = interpretExpanderProbe(raw)!;
    expect(probe.clampedBlocks).toBe(0);
    expect(probe.largest!.endsWithEllipsis).toBe(true);
    expect(descriptionVerdict(probe)).toBe("likely-request");
  });

  it("does not mistake prose containing the words for a control", () => {
    // A 40-char ceiling on the label: "see more of what we do at Acme…" inside a
    // paragraph is not a button, and counting it would invent a truncation.
    const raw = evaluateAgainst([
      el({ tagName: "A", textContent: "Read our blog to see more of what we do at Acme and beyond" }),
      el({ tagName: "P", textContent: "plain text" }),
    ]);
    expect(interpretExpanderProbe(raw)!.seeMoreControls).toBe(0);
  });

  it("ignores a layout container when picking the largest text block", () => {
    // Without the child-count bound the answer is always <body>, and the whole
    // measurement would describe the page rather than the description.
    const raw = evaluateAgainst([
      el({ tagName: "MAIN", textContent: "z".repeat(50_000), childElementCount: 40 }),
      el({ tagName: "P", textContent: "z".repeat(900), childElementCount: 1 }),
    ]);
    expect(interpretExpanderProbe(raw)!.largest!.tag).toBe("p");
  });

  it("stops at its stated bound and says so", () => {
    // A stated bound with a test that exceeds it. Past it the numbers describe a
    // prefix of the page, so the verdict must refuse rather than answer.
    const many = Array.from({ length: MAX_ELEMENTS + 5 }, () =>
      el({ tagName: "SPAN", textContent: "s" }),
    );
    const probe = interpretExpanderProbe(evaluateAgainst(many))!;
    expect(probe.elementsWalked).toBe(MAX_ELEMENTS);
    expect(probe.truncated).toBe(true);
    expect(descriptionVerdict(probe)).toBe("unknown");
  });

  it("returns a page with nothing hidden as not truncated", () => {
    const probe = interpretExpanderProbe(
      evaluateAgainst([el({ tagName: "P", textContent: "a short posting" })]),
    )!;
    expect(descriptionVerdict(probe)).toBe("not-truncated");
  });

  it("survives an element whose computed style cannot be read", () => {
    const nodes = [{ tagName: "P", textContent: "hi", id: "", getAttribute: () => null }];
    const document = { querySelectorAll: () => nodes, body: { textContent: "hi" } };
    const getComputedStyle = () => {
      throw new Error("detached");
    };
    const raw = new Function("document", "getComputedStyle", `return (${EXPANDER_EXPRESSION});`)(
      document,
      getComputedStyle,
    );
    expect(interpretExpanderProbe(raw)!.elementsWalked).toBe(1);
  });

  it("returns null rather than throwing when the page cannot be read at all", () => {
    const raw = new Function("document", "getComputedStyle", `return (${EXPANDER_EXPRESSION});`)(
      null,
      () => ({}),
    );
    expect(raw).toBeNull();
    expect(descriptionVerdict(interpretExpanderProbe(raw))).toBe("unknown");
  });
});

describe("interpretExpanderProbe and the verdict refuse to over-claim", () => {
  const base: ExpanderProbe = {
    seeMoreControls: 0, clampedBlocks: 0, largest: null, textChars: 0,
    elementsWalked: 10, truncated: false,
  };

  it("rejects anything that is not a measurement", () => {
    expect(interpretExpanderProbe(null)).toBeNull();
    expect(interpretExpanderProbe("x")).toBeNull();
    expect(interpretExpanderProbe({})).toBeNull();
  });

  it("says unknown when there is no text block at all", () => {
    expect(descriptionVerdict({ ...base, seeMoreControls: 1 })).toBe("unknown");
  });

  it("needs the clamp to be wider than the slack, not merely non-zero", () => {
    const largest = {
      chars: 100, tag: "div", componentkey: null, id: null,
      clientHeight: 300, scrollHeight: 300 + CLAMP_SLACK_PX, clamped: true, endsWithEllipsis: false,
    };
    // Exactly at the slack is a rounding difference, not hidden text.
    expect(descriptionVerdict({ ...base, largest, clampedBlocks: 0 })).toBe("unknown");
    expect(
      descriptionVerdict({ ...base, largest: { ...largest, scrollHeight: 400 } }),
    ).toBe("dom-toggle");
  });

  it("never answers from a truncated walk", () => {
    const largest = {
      chars: 4000, tag: "div", componentkey: null, id: null,
      clientHeight: 300, scrollHeight: 2400, clamped: true, endsWithEllipsis: false,
    };
    expect(descriptionVerdict({ ...base, largest })).toBe("dom-toggle");
    expect(descriptionVerdict({ ...base, largest, truncated: true })).toBe("unknown");
  });
});

describe("measureExpander never throws", () => {
  it("turns an evaluate failure into a null the caller warns about", async () => {
    const tab = {
      evaluate: async () => {
        throw new Error("execution context destroyed");
      },
    };
    await expect(measureExpander(tab)).resolves.toBeNull();
  });
});

import {
  bandLineCount,
  buildDigest,
  FOCUS_MARGIN_LINES,
  toBands,
} from "../codeDigest";

const PY = [
  "import math",                      // line 1
  "",                                 // line 2
  "def area(r):",                     // line 3
  "    return math.pi * r * r",       // line 4
  "",                                 // line 5
  "def main():",                      // line 6
  "    print(area(2))",               // line 7
];

describe("toBands", () => {
  it("collapses a run of consecutive lines into one band", () => {
    expect(toBands([3, 4, 5])).toEqual([{ start: 3, end: 5 }]);
  });

  it("splits at a gap and sorts ascending", () => {
    expect(toBands([9, 1, 2])).toEqual([
      { start: 1, end: 2 },
      { start: 9, end: 9 },
    ]);
  });

  it("de-duplicates repeated line numbers", () => {
    expect(toBands([4, 4, 5])).toEqual([{ start: 4, end: 5 }]);
  });

  it("returns nothing for no lines", () => {
    expect(toBands([])).toEqual([]);
  });
});

describe("bandLineCount", () => {
  it("counts inclusive ends", () => {
    expect(bandLineCount([{ start: 3, end: 5 }, { start: 9, end: 9 }])).toBe(4);
  });
});

describe("buildDigest emits the block the student is on", () => {
  it("keeps the block and a three-line margin, in 1-based coordinates", () => {
    // focus is 0-based: lines 3-4 of the file, which is `def area` and its body.
    const digest = buildDigest(PY, "python", { start: 2, end: 3 });
    expect(digest.bands).toEqual([{ start: 1, end: 7 }]);
    expect(FOCUS_MARGIN_LINES).toBe(3);
  });

  it("clamps the margin to the start and end of the file", () => {
    const digest = buildDigest(PY, "python", { start: 0, end: 0 });
    expect(digest.bands[0].start).toBe(1);
    const last = buildDigest(PY, "python", { start: 6, end: 6 });
    expect(last.bands[last.bands.length - 1].end).toBe(7);
  });

  it("reports the file's real length, not the digest's", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line_${i + 1} = ${i + 1}`);
    expect(buildDigest(long, "python", { start: 20, end: 21 }).totalLines).toBe(50);
  });

  it("holds the invariant the backend validates: one digest line per band line", () => {
    // The backend rejects a `bands` list whose total length disagrees with the
    // code it arrived with, and falls back to treating the digest as a whole
    // file — which renumbers every line and sends the student to the wrong one.
    const digest = buildDigest(PY, "python", { start: 5, end: 6 });
    expect(digest.code.split("\n")).toHaveLength(bandLineCount(digest.bands));
  });

  it("returns an empty digest for an empty file", () => {
    expect(buildDigest([], "python", { start: 0, end: 0 })).toEqual({
      code: "",
      bands: [],
      totalLines: 0,
    });
  });
});

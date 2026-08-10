import { buildProgressHtml } from "../progressPanel";
import type { ProgressReport } from "../apiClient";

function report(overrides: Partial<ProgressReport> = {}): ProgressReport {
  return {
    badges: [],
    total_interactions: 0,
    sessions: 0,
    streak_days: 0,
    languages_used: [],
    goal: null,
    concept_struggles: [],
    concept_strengths: [],
    session_summaries: [],
    review_due: false,
    ...overrides,
  };
}

describe("buildProgressHtml", () => {
  it("renders stat tiles", () => {
    const html = buildProgressHtml(report({ total_interactions: 12, streak_days: 4 }));
    expect(html).toContain("12");
    expect(html).toContain("day streak");
  });

  it("renders badges", () => {
    const html = buildProgressHtml(report({ badges: ["First Question"] }));
    expect(html).toContain("First Question");
  });

  it("renders struggle bars at the right width", () => {
    const html = buildProgressHtml(
      report({ concept_struggles: [{ concept: "recursion", encounters: 3, avg_level: 3 }] })
    );
    expect(html).toContain("recursion");
    // Geometry lives in SVG attributes, not style attributes, so the panel
    // runs under a CSP without 'unsafe-inline' for scripts.
    expect(html).toContain('width="100"');
  });

  it("scales a partial struggle bar", () => {
    const html = buildProgressHtml(
      report({ concept_struggles: [{ concept: "loops", encounters: 2, avg_level: 1.5 }] })
    );
    expect(html).toContain('width="50"');
  });

  it("shows the review banner only when due", () => {
    expect(buildProgressHtml(report({ review_due: true }))).toContain("spaced review is ready");
    expect(buildProgressHtml(report())).not.toContain("spaced review is ready");
  });

  it("escapes html in user-controlled fields", () => {
    const html = buildProgressHtml(
      report({ goal: { text: "<script>alert(1)</script>", concepts: [] } })
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes html in concept names and badges", () => {
    const html = buildProgressHtml(
      report({
        badges: ["<img src=x onerror=alert(1)>"],
        concept_struggles: [{ concept: "<b>bold</b>", encounters: 2, avg_level: 2 }],
      })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("escapes quotes so attributes cannot be broken out of", () => {
    const html = buildProgressHtml(
      report({ concept_struggles: [{ concept: '" onload="x', encounters: 2, avg_level: 2 }] })
    );
    expect(html).not.toContain('" onload="x');
    expect(html).toContain("&quot;");
  });

  it("shows newest session summary first", () => {
    const html = buildProgressHtml(
      report({
        session_summaries: [
          { text: "older", date: "2026-07-01" },
          { text: "newer", date: "2026-07-03" },
        ],
      })
    );
    expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
  });
});

describe("hint level distribution", () => {
  it("says so when there are no hints yet", () => {
    expect(buildProgressHtml(report())).toContain("no depth to report");
  });

  it("renders one segment per level with percentages", () => {
    const html = buildProgressHtml(
      report({ hint_level_counts: { "1": 6, "2": 3, "3": 1 } })
    );
    expect(html).toContain("seg--1");
    expect(html).toContain("seg--2");
    expect(html).toContain("seg--3");
    expect(html).toContain("60%");
  });

  it("labels every level in text, not only by colour", () => {
    const html = buildProgressHtml(report({ hint_level_counts: { "1": 1, "2": 1, "3": 1 } }));
    expect(html).toContain("Level 1");
    expect(html).toContain("Level 2");
    expect(html).toContain("Level 3");
  });

  it("survives an all-zero distribution", () => {
    const html = buildProgressHtml(report({ hint_level_counts: { "1": 0, "2": 0, "3": 0 } }));
    expect(html).toContain("no depth to report");
  });
});

describe("activity strip", () => {
  it("prompts when there is no activity data", () => {
    expect(buildProgressHtml(report())).toContain("daily activity shows up here");
  });

  it("draws one bar per day and counts the active ones", () => {
    const html = buildProgressHtml(
      report({
        activity: [
          { date: "2026-08-03", count: 0 },
          { date: "2026-08-04", count: 2 },
          { date: "2026-08-05", count: 5 },
        ],
      })
    );
    expect((html.match(/class="day/g) ?? []).length).toBe(3);
    expect(html).toContain("active on 2 of 3 days");
  });

  it("marks empty days as idle", () => {
    const html = buildProgressHtml(
      report({ activity: [{ date: "2026-08-05", count: 0 }] })
    );
    expect(html).toContain("day--idle");
  });

  it("escapes dates coming back from the backend", () => {
    const html = buildProgressHtml(
      report({ activity: [{ date: '"><script>x</script>', count: 1 }] })
    );
    expect(html).not.toContain("<script>x</script>");
  });
});

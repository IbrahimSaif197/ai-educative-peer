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

  it("renders struggle bars with widths", () => {
    const html = buildProgressHtml(
      report({ concept_struggles: [{ concept: "recursion", encounters: 3, avg_level: 3 }] })
    );
    expect(html).toContain("recursion");
    expect(html).toContain("width:100%");
  });

  it("shows the review banner only when due", () => {
    expect(buildProgressHtml(report({ review_due: true }))).toContain("review is due");
    expect(buildProgressHtml(report())).not.toContain("review is due");
  });

  it("escapes html in user-controlled fields", () => {
    const html = buildProgressHtml(
      report({ goal: { text: "<script>alert(1)</script>", concepts: [] } })
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
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

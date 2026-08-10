import { renderStatus } from "../statusBar";

const base = { hintLevel: 0, streakDays: 0, reviewDue: false, offline: false };

describe("renderStatus", () => {
  it("names the extension even when there is nothing to report", () => {
    expect(renderStatus(base).text).toContain("EduPeer");
  });

  it("shows the hint depth once a hint has been given", () => {
    expect(renderStatus({ ...base, hintLevel: 2 }).text).toContain("hint 2/4");
  });

  it("hides the depth before the first hint", () => {
    expect(renderStatus(base).text).not.toContain("hint");
  });

  /**
   * The ladder has four rungs — rung 4 *is* the worked example. Capping at 3
   * left the bar reading "hint 3/3" beside a panel showing "hint 4" and four
   * filled dots.
   */
  it("shows the fourth rung rather than capping at the third", () => {
    expect(renderStatus({ ...base, hintLevel: 4 }).text).toContain("hint 4/4");
  });

  it("clamps a depth beyond the top rung", () => {
    expect(renderStatus({ ...base, hintLevel: 9 }).text).toContain("hint 4/4");
  });

  it("shows a streak in days", () => {
    expect(renderStatus({ ...base, streakDays: 6 }).text).toContain("6d");
  });

  it("omits a zero streak", () => {
    expect(renderStatus(base).text).not.toContain("0d");
  });

  it("flags a due review with an icon", () => {
    expect(renderStatus({ ...base, reviewDue: true }).text).toContain("$(history)");
  });

  it("reports offline instead of a stale depth", () => {
    const status = renderStatus({ ...base, hintLevel: 2, offline: true });
    expect(status.text).toContain("offline");
    expect(status.text).not.toContain("hint 2/4");
  });

  it("explains each part in the tooltip", () => {
    const status = renderStatus({ ...base, hintLevel: 2, streakDays: 3, reviewDue: true });
    expect(status.tooltip).toContain("Hint depth on this problem: 2 of 4");
    expect(status.tooltip).toContain("Practice streak: 3 days");
    expect(status.tooltip).toContain("spaced review is ready");
    expect(status.tooltip).toContain("Click to open the tutor panel");
  });

  it("uses the singular for a one-day streak", () => {
    expect(renderStatus({ ...base, streakDays: 1 }).tooltip).toContain("1 day");
    expect(renderStatus({ ...base, streakDays: 1 }).tooltip).not.toContain("1 days");
  });

  it("invites the student to start a streak when there is none", () => {
    expect(renderStatus(base).tooltip).toContain("practise today");
  });

  it("says why hints are local when offline", () => {
    expect(renderStatus({ ...base, offline: true }).tooltip).toContain("local rules");
  });

  it("distinguishes a sign-in failure from an unreachable backend", () => {
    const status = renderStatus({ ...base, authFailed: true });
    expect(status.text).toContain("sign-in");
    expect(status.text).not.toContain("offline");
    expect(status.tooltip).toContain("Sign-in unavailable");
  });

  it("prefers offline over sign-in when the backend is down too", () => {
    const status = renderStatus({ ...base, offline: true, authFailed: true });
    expect(status.text).toContain("offline");
    expect(status.text).not.toContain("sign-in");
  });
});

describe("renderStatus — thinking", () => {
  it("shows a spinner while a line hint is in flight", () => {
    const { text } = renderStatus({
      hintLevel: 0,
      streakDays: 0,
      reviewDue: false,
      offline: false,
      thinking: true,
    });
    expect(text).toContain("$(sync~spin)");
  });

  it("says so in the tooltip", () => {
    const { tooltip } = renderStatus({
      hintLevel: 0,
      streakDays: 0,
      reviewDue: false,
      offline: false,
      thinking: true,
    });
    expect(tooltip).toContain("Working on a hint for the line you're on");
  });

  it("keeps the offline warning ahead of the spinner", () => {
    const { text } = renderStatus({
      hintLevel: 0,
      streakDays: 0,
      reviewDue: false,
      offline: true,
      thinking: true,
    });
    expect(text).toContain("offline");
    expect(text).not.toContain("$(sync~spin)");
  });

  it("shows no spinner when nothing is in flight", () => {
    const { text } = renderStatus({
      hintLevel: 2,
      streakDays: 0,
      reviewDue: false,
      offline: false,
    });
    expect(text).not.toContain("$(sync~spin)");
  });
});

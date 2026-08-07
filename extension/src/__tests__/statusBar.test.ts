import { renderStatus } from "../statusBar";

const base = { hintLevel: 0, streakDays: 0, reviewDue: false, offline: false };

describe("renderStatus", () => {
  it("names the extension even when there is nothing to report", () => {
    expect(renderStatus(base).text).toContain("EduPeer");
  });

  it("shows the hint depth once a hint has been given", () => {
    expect(renderStatus({ ...base, hintLevel: 2 }).text).toContain("hint 2/3");
  });

  it("hides the depth before the first hint", () => {
    expect(renderStatus(base).text).not.toContain("hint");
  });

  it("clamps a depth beyond level 3", () => {
    expect(renderStatus({ ...base, hintLevel: 9 }).text).toContain("hint 3/3");
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
    expect(status.text).not.toContain("hint 2/3");
  });

  it("explains each part in the tooltip", () => {
    const status = renderStatus({ ...base, hintLevel: 2, streakDays: 3, reviewDue: true });
    expect(status.tooltip).toContain("Hint depth on this problem: 2 of 3");
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

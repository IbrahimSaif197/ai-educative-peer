/**
 * A one-glance status bar entry: how deep you are on the current problem, how
 * long your streak is, and whether a review is waiting.
 *
 * Hidden unless a supported file is open, so it never clutters the bar for
 * people who are not using EduPeer right now.
 */

import * as vscode from "vscode";

export interface StatusSnapshot {
  hintLevel: number;
  streakDays: number;
  reviewDue: boolean;
  offline: boolean;
  /** Sign-in is failing even though the backend is answering. */
  authFailed?: boolean;
  /** A line hint is in flight. Mirrors the inline lens's loading state. */
  thinking?: boolean;
}

/** Pure: the text and tooltip for a snapshot, so it can be unit-tested. */
export function renderStatus(snapshot: StatusSnapshot): { text: string; tooltip: string } {
  const parts: string[] = ["$(mortar-board) EduPeer"];
  if (snapshot.offline) {
    parts.push("offline");
  } else if (snapshot.authFailed) {
    parts.push("sign-in error");
  } else if (snapshot.thinking) {
    parts.push("$(sync~spin)");
  } else if (snapshot.hintLevel >= 1) {
    parts.push(`hint ${Math.min(3, snapshot.hintLevel)}/3`);
  }
  if (snapshot.streakDays > 0) {
    parts.push(`${snapshot.streakDays}d`);
  }
  if (snapshot.reviewDue) {
    parts.push("$(history)");
  }

  const tooltipLines = [
    snapshot.hintLevel >= 1
      ? `Hint depth on this problem: ${Math.min(3, snapshot.hintLevel)} of 3`
      : "No hints used on this problem yet",
    snapshot.streakDays > 0
      ? `Practice streak: ${snapshot.streakDays} day${snapshot.streakDays === 1 ? "" : "s"}`
      : "No streak yet — practise today to start one",
  ];
  if (snapshot.thinking) {
    tooltipLines.push("Working on a hint for the line you're on");
  }
  if (snapshot.reviewDue) tooltipLines.push("A spaced review is ready");
  if (snapshot.offline) {
    tooltipLines.push("Backend unreachable — hints are local rules for now");
  } else if (snapshot.authFailed) {
    tooltipLines.push("Sign-in unavailable — the backend is up but Firebase auth is failing");
  }
  tooltipLines.push("Click to open the tutor panel");

  return { text: parts.join(" "), tooltip: tooltipLines.join("\n") };
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private snapshot: StatusSnapshot = {
    hintLevel: 0,
    streakDays: 0,
    reviewDue: false,
    offline: false,
    thinking: false,
  };

  constructor(private readonly isRelevant: () => boolean) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "edupeer.activate";
    this.refresh();
  }

  update(patch: Partial<StatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.refresh();
  }

  refresh(): void {
    if (!this.isRelevant()) {
      this.item.hide();
      return;
    }
    const { text, tooltip } = renderStatus(this.snapshot);
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor =
      this.snapshot.offline || this.snapshot.authFailed
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

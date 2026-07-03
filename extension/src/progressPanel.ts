import type { ConceptStat, ProgressReport } from "./apiClient";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statTile(label: string, value: string | number): string {
  return `<div class="tile"><div class="value">${escapeHtml(String(value))}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

function conceptBars(items: ConceptStat[], maxLevel = 3): string {
  if (!items.length) {
    return `<p class="empty">Nothing here yet — keep coding!</p>`;
  }
  return items
    .map((item) => {
      const pct = Math.round((Math.min(item.avg_level, maxLevel) / maxLevel) * 100);
      return `<div class="bar-row">
        <span class="bar-label">${escapeHtml(item.concept)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-meta">avg hint ${item.avg_level} · ${item.encounters}×</span>
      </div>`;
    })
    .join("\n");
}

/** Pure HTML builder for the progress dashboard (tested in jest). */
export function buildProgressHtml(progress: ProgressReport): string {
  const badges = progress.badges.length
    ? progress.badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")
    : `<span class="empty">No badges yet</span>`;
  const goal = progress.goal
    ? `<p>🎯 ${escapeHtml(progress.goal.text)}${
        progress.goal.concepts.length
          ? ` <span class="bar-meta">(${progress.goal.concepts.map(escapeHtml).join(", ")})</span>`
          : ""
      }</p>`
    : `<p class="empty">No goal set — run <code>EduPeer: Set Learning Goal</code>.</p>`;
  const summaries = progress.session_summaries.length
    ? progress.session_summaries
        .slice()
        .reverse()
        .map(
          (s) =>
            `<div class="summary"><div class="bar-meta">${escapeHtml(s.date)}</div><pre>${escapeHtml(s.text)}</pre></div>`
        )
        .join("\n")
    : `<p class="empty">Reset a session to get your first summary.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px; max-width: 720px; }
  h1 { font-size: 1.4em; } h2 { font-size: 1.05em; margin-top: 24px; opacity: 0.9; }
  .tiles { display: flex; gap: 12px; flex-wrap: wrap; }
  .tile { border: 1px solid var(--vscode-widget-border, #444); border-radius: 6px; padding: 10px 16px; min-width: 90px; text-align: center; }
  .tile .value { font-size: 1.6em; font-weight: 600; }
  .tile .label { font-size: 0.8em; opacity: 0.7; }
  .badge { display: inline-block; padding: 2px 10px; margin: 2px; border-radius: 10px; background: var(--vscode-badge-background, #3c3c3c); color: var(--vscode-badge-foreground, #fff); font-size: 0.85em; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .bar-label { width: 130px; font-size: 0.9em; }
  .bar-track { flex: 1; height: 8px; background: var(--vscode-editorWidget-background, #333); border-radius: 4px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: var(--vscode-progressBar-background, #0e70c0); }
  .bar-meta { font-size: 0.75em; opacity: 0.7; }
  .empty { opacity: 0.6; font-style: italic; }
  .summary pre { white-space: pre-wrap; font-family: inherit; margin: 2px 0 10px; }
  .review-due { border-left: 3px solid var(--vscode-progressBar-background, #0e70c0); padding-left: 10px; }
</style>
</head>
<body>
  <h1>Your EduPeer progress</h1>
  <div class="tiles">
    ${statTile("questions asked", progress.total_interactions)}
    ${statTile("sessions", progress.sessions)}
    ${statTile("day streak", progress.streak_days)}
    ${statTile("languages", progress.languages_used.length)}
  </div>
  ${progress.review_due ? `<p class="review-due">🔁 A review is due — open the EduPeer sidebar and hit Review.</p>` : ""}
  <h2>Badges</h2>
  <div>${badges}</div>
  <h2>Goal</h2>
  ${goal}
  <h2>Concepts to revisit</h2>
  ${conceptBars(progress.concept_struggles)}
  <h2>Your strengths</h2>
  ${conceptBars(progress.concept_strengths)}
  <h2>Recent session notes</h2>
  ${summaries}
</body>
</html>`;
}

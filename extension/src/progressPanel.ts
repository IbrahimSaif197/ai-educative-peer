import type { ActivityDay, ConceptStat, ProgressReport } from "./apiClient";
import { MAX_HINT_LEVEL } from "./pedagogy";

/**
 * Pure HTML builder for the progress dashboard (tested in jest).
 *
 * Charts are hand-written SVG: no library, no network, and geometry lives in
 * element attributes rather than style attributes so the panel runs under a
 * strict CSP. Colour comes from VS Code chart tokens, and every series is also
 * labelled in text — hue never carries meaning on its own.
 */

function escapeHtml(text: string | number): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statTile(label: string, value: string | number): string {
  return `<div class="tile">
    <div class="tile__value">${escapeHtml(value)}</div>
    <div class="tile__label">${escapeHtml(label)}</div>
  </div>`;
}

// `_update_concept_stats` counts rung-4 hints, so an average above 3 is
// ordinary rather than a glitch. Scaling against 3 pinned every deep concept
// at a full bar and told a screen reader "average hint depth 3.5 of 3".
function conceptBars(items: ConceptStat[], maxLevel = MAX_HINT_LEVEL): string {
  if (!items.length) {
    return `<p class="empty">Nothing here yet. Ask a few questions and this fills in.</p>`;
  }
  return items
    .map((item) => {
      const pct = Math.round((Math.min(item.avg_level, maxLevel) / maxLevel) * 100);
      return `<div class="row">
        <span class="row__label">${escapeHtml(item.concept)}</span>
        <span class="row__track">
          <svg viewBox="0 0 100 6" preserveAspectRatio="none" role="img"
               aria-label="${escapeHtml(item.concept)}: average hint depth ${escapeHtml(item.avg_level)} of ${maxLevel}">
            <rect x="0" y="0" width="100" height="6" rx="3" class="track"></rect>
            <rect x="0" y="0" width="${pct}" height="6" rx="3" class="fill"></rect>
          </svg>
        </span>
        <span class="row__meta">avg ${escapeHtml(item.avg_level)} · ${escapeHtml(item.encounters)}×</span>
      </div>`;
    })
    .join("\n");
}

const LEVEL_BLURBS = [
  "a question was enough",
  "needed the line pointed out",
  "needed pseudocode",
  "needed a worked example",
];

/** Stacked bar of how many hints landed at each depth. */
function levelDistribution(counts: Record<string, number> | undefined): string {
  const values = LEVEL_BLURBS.map((_, i) =>
    Math.max(0, Number(counts?.[String(i + 1)] ?? 0))
  );
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) {
    return `<p class="empty">No hints yet, so there's no depth to report.</p>`;
  }
  const pct = (n: number) => Math.round((n / total) * 100);

  let x = 0;
  const rects = values
    .map((n, i) => {
      const w = (n / total) * 100;
      const rect = `<rect x="${x}" y="0" width="${w}" height="10" class="seg seg--${i + 1}"></rect>`;
      x += w;
      return rect;
    })
    .join("\n    ");

  const label = values.map((n, i) => `${pct(n)}% at level ${i + 1}`).join(", ");
  const legend = values
    .map(
      (n, i) =>
        `<li><span class="key key--${i + 1}"></span>Level ${i + 1} — ${LEVEL_BLURBS[i]} · ${n} (${pct(n)}%)</li>`
    )
    .join("\n    ");

  return `<svg class="stack" viewBox="0 0 100 10" preserveAspectRatio="none" role="img"
       aria-label="Hint depth: ${label}">
    ${rects}
  </svg>
  <ul class="legend">
    ${legend}
  </ul>`;
}

/** Fourteen-day activity strip; height encodes the day's question count. */
function activityStrip(days: ActivityDay[] | undefined): string {
  const strip = days ?? [];
  if (!strip.length) {
    return `<p class="empty">Your daily activity shows up here once you start asking.</p>`;
  }
  const peak = Math.max(1, ...strip.map((d) => d.count));
  const slot = 100 / strip.length;
  const barWidth = slot * 0.66;
  const bars = strip
    .map((day, index) => {
      const height = day.count ? Math.max(2, (day.count / peak) * 20) : 1;
      const x = index * slot + (slot - barWidth) / 2;
      const cls = day.count ? "day" : "day day--idle";
      return `<rect x="${x.toFixed(2)}" y="${(20 - height).toFixed(2)}" width="${barWidth.toFixed(2)}"
        height="${height.toFixed(2)}" rx="0.6" class="${cls}"><title>${escapeHtml(day.date)}: ${escapeHtml(
        day.count
      )} question${day.count === 1 ? "" : "s"}</title></rect>`;
    })
    .join("");
  const active = strip.filter((d) => d.count > 0).length;

  return `<svg class="strip" viewBox="0 0 100 20" preserveAspectRatio="none" role="img"
       aria-label="Activity over the last ${strip.length} days: active on ${active} of them">
    ${bars}
  </svg>
  <p class="row__meta">${escapeHtml(strip[0].date)} → ${escapeHtml(
    strip[strip.length - 1].date
  )} · active on ${active} of ${strip.length} days</p>`;
}

export function buildProgressHtml(progress: ProgressReport): string {
  const badges = progress.badges.length
    ? progress.badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")
    : `<span class="empty">No badges yet</span>`;

  const goal = progress.goal
    ? `<p class="goal">${escapeHtml(progress.goal.text)}${
        progress.goal.concepts.length
          ? ` <span class="row__meta">${progress.goal.concepts.map(escapeHtml).join(" · ")}</span>`
          : ""
      }</p>`
    : `<p class="empty">No goal set. Run <code>EduPeer: Set Learning Goal</code> and hints will lean that way.</p>`;

  const summaries = progress.session_summaries.length
    ? progress.session_summaries
        .slice()
        .reverse()
        .map(
          (s) =>
            `<article class="note"><div class="row__meta">${escapeHtml(
              s.date
            )}</div><pre>${escapeHtml(s.text)}</pre></article>`
        )
        .join("\n")
    : `<p class="empty">Reset a session and EduPeer writes you a short note on what you covered.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>EduPeer progress</title>
<style>
  :root {
    color-scheme: light dark;
    --ink: var(--vscode-foreground);
    --dim: var(--vscode-descriptionForeground, var(--vscode-foreground));
    --line: var(--vscode-panel-border, rgba(127,127,127,0.28));
    --raised: var(--vscode-editorWidget-background, rgba(127,127,127,0.1));
    --accent: var(--vscode-textLink-foreground, #3794ff);
    --mono: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
    --c1: var(--vscode-charts-blue, #3794ff);
    --c2: var(--vscode-charts-purple, #b180d7);
    --c3: var(--vscode-charts-orange, #d18616);
    --c4: var(--vscode-charts-green, #89d185);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.55;
    color: var(--ink);
    background: var(--vscode-editor-background);
    margin: 0 auto;
    padding: 32px 28px 64px;
    max-width: 760px;
  }
  h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  .lede { color: var(--dim); margin: 0 0 28px; }
  h2 {
    font-family: var(--mono);
    font-size: 0.72em;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 34px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 10px; }
  .tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  .tile__value { font-family: var(--mono); font-size: 1.7em; font-weight: 600; line-height: 1.1; }
  .tile__label { font-size: 0.78em; color: var(--dim); }
  .badge {
    display: inline-block; font-family: var(--mono); font-size: 0.76em;
    padding: 2px 8px; margin: 0 4px 4px 0; border-radius: 4px;
    background: var(--vscode-badge-background, var(--raised));
    color: var(--vscode-badge-foreground, var(--ink));
  }
  .row { display: flex; align-items: center; gap: 12px; margin: 6px 0; }
  .row__label { width: 140px; flex: none; font-family: var(--mono); font-size: 0.82em; }
  .row__track { flex: 1; height: 6px; display: block; }
  .row__track svg { display: block; width: 100%; height: 6px; }
  .row__meta { font-family: var(--mono); font-size: 0.74em; color: var(--dim); }
  .track { fill: var(--raised); }
  .fill { fill: var(--accent); }
  .stack { display: block; width: 100%; height: 10px; border-radius: 5px; overflow: hidden; }
  .seg--1 { fill: var(--c1); }
  .seg--2 { fill: var(--c2); }
  .seg--3 { fill: var(--c3); }
  .seg--4 { fill: var(--c4); }
  .legend { list-style: none; margin: 10px 0 0; padding: 0; font-size: 0.82em; color: var(--dim); }
  .legend li { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .key { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .key--1 { background: var(--c1); }
  .key--2 { background: var(--c2); }
  .key--3 { background: var(--c3); }
  .key--4 { background: var(--c4); }
  .strip { display: block; width: 100%; height: 44px; }
  .day { fill: var(--accent); }
  .day--idle { fill: var(--raised); }
  .goal { margin: 0; }
  .note pre { white-space: pre-wrap; font-family: inherit; margin: 2px 0 14px; }
  .empty { color: var(--dim); margin: 4px 0; }
  code { font-family: var(--mono); font-size: 0.9em; }
  .review {
    border-left: 2px solid var(--accent); padding: 4px 0 4px 12px;
    margin: 18px 0 0; color: var(--ink);
  }
</style>
</head>
<body>
  <h1>Your progress</h1>
  <p class="lede">What you've practised, where you needed the most help, and how that's trending over time.</p>

  <div class="tiles">
    ${statTile("questions asked", progress.total_interactions)}
    ${statTile("sessions", progress.sessions)}
    ${statTile("day streak", progress.streak_days)}
    ${statTile("languages", progress.languages_used.length)}
  </div>
  ${
    progress.review_due
      ? `<p class="review">A spaced review is ready. Open the EduPeer panel and hit Review.</p>`
      : ""
  }

  <h2>Hint depth</h2>
  ${levelDistribution(progress.hint_level_counts)}

  <h2>Last 14 days</h2>
  ${activityStrip(progress.activity)}

  <h2>Concepts to revisit</h2>
  ${conceptBars(progress.concept_struggles)}

  <h2>Your strengths</h2>
  ${conceptBars(progress.concept_strengths)}

  <h2>Goal</h2>
  ${goal}

  <h2>Badges</h2>
  <div>${badges}</div>

  <h2>Session notes</h2>
  ${summaries}
</body>
</html>`;
}

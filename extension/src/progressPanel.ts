import type { ActivityDay, ConceptStat, ProgressReport } from "./apiClient";

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

function conceptBars(items: ConceptStat[], maxLevel = 3): string {
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
               aria-label="${escapeHtml(item.concept)}: average hint depth ${escapeHtml(item.avg_level)} of 3">
            <rect x="0" y="0" width="100" height="6" rx="3" class="track"></rect>
            <rect x="0" y="0" width="${pct}" height="6" rx="3" class="fill"></rect>
          </svg>
        </span>
        <span class="row__meta">avg ${escapeHtml(item.avg_level)} · ${escapeHtml(item.encounters)}×</span>
      </div>`;
    })
    .join("\n");
}

/** Stacked bar of how many hints landed at each depth. */
function levelDistribution(counts: Record<string, number> | undefined): string {
  const one = Math.max(0, Number(counts?.["1"] ?? 0));
  const two = Math.max(0, Number(counts?.["2"] ?? 0));
  const three = Math.max(0, Number(counts?.["3"] ?? 0));
  const total = one + two + three;
  if (!total) {
    return `<p class="empty">No hints yet, so there's no depth to report.</p>`;
  }
  const w1 = (one / total) * 100;
  const w2 = (two / total) * 100;
  const w3 = (three / total) * 100;
  const pct = (n: number) => Math.round((n / total) * 100);

  return `<svg class="stack" viewBox="0 0 100 10" preserveAspectRatio="none" role="img"
       aria-label="Hint depth: ${pct(one)}% at level 1, ${pct(two)}% at level 2, ${pct(three)}% at level 3">
    <rect x="0" y="0" width="${w1}" height="10" class="seg seg--1"></rect>
    <rect x="${w1}" y="0" width="${w2}" height="10" class="seg seg--2"></rect>
    <rect x="${w1 + w2}" y="0" width="${w3}" height="10" class="seg seg--3"></rect>
  </svg>
  <ul class="legend">
    <li><span class="key key--1"></span>Level 1 — a question was enough · ${one} (${pct(one)}%)</li>
    <li><span class="key key--2"></span>Level 2 — needed the line pointed out · ${two} (${pct(two)}%)</li>
    <li><span class="key key--3"></span>Level 3 — needed pseudocode · ${three} (${pct(three)}%)</li>
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

/** Confidence-versus-outcome readout. */
function calibration(report: ProgressReport): string {
  const data = report.calibration;
  if (!data || !data.enough_data) {
    const have = data?.samples ?? 0;
    return `<p class="empty">Rate how sure you are before a few more hints (${escapeHtml(
      have
    )} so far) and EduPeer will show how well your confidence matches reality.</p>`;
  }
  const pct = Math.round(data.score * 100);
  return `<div class="calibration">
    <div class="calibration__score">${pct}<span>%</span></div>
    <div>
      <p class="calibration__lead">of your ${escapeHtml(data.samples)} rated questions matched how much help you actually needed.</p>
      <p class="row__meta">Sure but needed pseudocode: ${escapeHtml(
        data.overconfident
      )} · Unsure but solved it first ask: ${escapeHtml(data.underconfident)}</p>
    </div>
  </div>`;
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
  .legend { list-style: none; margin: 10px 0 0; padding: 0; font-size: 0.82em; color: var(--dim); }
  .legend li { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .key { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .key--1 { background: var(--c1); }
  .key--2 { background: var(--c2); }
  .key--3 { background: var(--c3); }
  .strip { display: block; width: 100%; height: 44px; }
  .day { fill: var(--accent); }
  .day--idle { fill: var(--raised); }
  .calibration { display: flex; align-items: center; gap: 18px; }
  .calibration__score { font-family: var(--mono); font-size: 2.6em; font-weight: 600; line-height: 1; }
  .calibration__score span { font-size: 0.42em; color: var(--dim); margin-left: 2px; }
  .calibration__lead { margin: 0 0 2px; }
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
  <p class="lede">What you've practised, where you needed the most help, and how well you can predict that.</p>

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

  <h2>Confidence vs. reality</h2>
  ${calibration(progress)}

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

// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { mapToToolCallUsage, sumToolCalls, type OverallStats, type ProjectStats } from "./types.ts";
import { fmtCompact, fmtCost, fmtDate, fmtNumber } from "./format.ts";
import { creditsFromCost, DEFAULT_CREDIT_CONFIG, type CreditConfig } from "./credits.ts";
import { formatDateRange } from "./date-range.ts";

function headerImageDataUri(): string {
  try {
    const imgPath = join(import.meta.dir, "..", "docs", "images", "header.jpeg");
    const data = readFileSync(imgPath);
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  } catch {
    return "";
  }
}

function totalTokens(t: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

function fmtCredits(cost: number, config: CreditConfig): string {
  return fmtNumber(creditsFromCost(cost, config));
}

function fmtEffortHours(ms: number): string {
  if (ms <= 0) return "—";
  const h = ms / 3_600_000;
  return h < 0.1 ? "<0.1 h" : `${h.toFixed(1)} h`;
}

function fmtEffortMins(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return "—";
  const m = ms / 60_000;
  return m < 1 ? "<1 m" : `${Math.round(m)} m`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PALETTE = ["#0369a1", "#7c3aed", "#b45309", "#15803d", "#be123c", "#0284c7", "#db2777", "#a16207", "#059669", "#9333ea"];

/** A simple horizontal bar chart as inline SVG. No external libs, no network calls. */
function horizontalBarChart(
  rows: Array<{ label: string; value: number; display: string }>,
  opts: { width?: number; barHeight?: number; gap?: number; colorFn?: (i: number) => string } = {},
): string {
  const width = opts.width ?? 960;
  const barHeight = opts.barHeight ?? 30;
  const gap = opts.gap ?? 14;
  const labelWidth = 210;
  const valueWidth = 82;
  const chartWidth = width - labelWidth - valueWidth;
  const height = Math.max(150, rows.length * (barHeight + gap) + gap);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const colorFn = opts.colorFn ?? ((i: number) => PALETTE[i % PALETTE.length]);

  const barFontSize = Math.round(barHeight * 0.55);

  const bars = rows
    .map((r, i) => {
      const y = gap + i * (barHeight + gap);
      const barWidth = Math.max(2, (r.value / max) * chartWidth);
      const yMid = y + barHeight / 2;
      return `
        <text x="${labelWidth - 10}" y="${yMid}" text-anchor="end" dominant-baseline="central" font-size="${barFontSize}" class="bar-label">${esc(r.label)}</text>
        <rect x="${labelWidth}" y="${y}" width="${chartWidth}" height="${barHeight}" rx="4" fill="#e2e8f0" />
        <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="${colorFn(i)}" opacity="0.85" />
        <text x="${Math.min(labelWidth + barWidth + 8, width - valueWidth + 4)}" y="${yMid}" dominant-baseline="central" font-size="${barFontSize}" class="bar-value">${esc(r.display)}</text>
      `;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" class="chart" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

/** A simple donut chart as inline SVG. */
function donutChart(rows: Array<{ label: string; value: number; display: string }>, opts: { size?: number } = {}): string {
  const size = opts.size ?? 320;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 8;
  const rInner = rOuter * 0.55;
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;

  // format total compactly for the centre label
  function fmtCentre(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  let angle = -Math.PI / 2;
  const segments = rows
    .map((r, i) => {
      const frac = r.value / total;
      const start = angle;
      const end = angle + frac * Math.PI * 2;
      angle = end;
      const largeArc = end - start > Math.PI ? 1 : 0;
      const x1 = cx + rOuter * Math.cos(start);
      const y1 = cy + rOuter * Math.sin(start);
      const x2 = cx + rOuter * Math.cos(end);
      const y2 = cy + rOuter * Math.sin(end);
      const ix1 = cx + rInner * Math.cos(end);
      const iy1 = cy + rInner * Math.sin(end);
      const ix2 = cx + rInner * Math.cos(start);
      const iy2 = cy + rInner * Math.sin(start);
      const path = `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${rInner} ${rInner} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
      return `<path d="${path}" fill="${PALETTE[i % PALETTE.length]}" opacity="0.88"><title>${esc(r.label)}: ${esc(r.display)}</title></path>`;
    })
    .join("");

  // centre label inside the hole
  const centreLabelFontSize = Math.round(rInner * 0.32);
  const centreSubFontSize   = Math.round(rInner * 0.20);
  const centreLabel = `
    <circle cx="${cx}" cy="${cy}" r="${rInner - 2}" fill="white" opacity="0.92"/>
    <text x="${cx}" y="${cy - centreSubFontSize * 0.6}" text-anchor="middle" dominant-baseline="middle"
      font-size="${centreLabelFontSize}" font-weight="700" fill="#1e293b"
      font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${esc(fmtCentre(total))}</text>
    <text x="${cx}" y="${cy + centreLabelFontSize * 0.72}" text-anchor="middle" dominant-baseline="middle"
      font-size="${centreSubFontSize}" fill="#64748b"
      font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">tokens</text>
  `;

  const providers = new Map<string, Array<{ row: (typeof rows)[number]; index: number }>>();
  rows.forEach((row, index) => {
    const separator = row.label.indexOf("/");
    const provider = separator >= 0 ? row.label.slice(0, separator) : "unknown";
    const group = providers.get(provider);
    if (group) group.push({ row, index });
    else providers.set(provider, [{ row, index }]);
  });

  const legend = [...providers.entries()]
    .map(
      ([provider, models]) =>
        `<div class="legend-group">` +
        `<div class="legend-provider">${esc(provider)}</div>` +
        models
          .map(({ row, index }) => {
            const separator = row.label.indexOf("/");
            const model = separator >= 0 ? row.label.slice(separator + 1) : row.label;
            return (
              `<div class="legend-item" title="${esc(row.label)}">` +
              `<span class="legend-swatch" style="background:${PALETTE[index % PALETTE.length]}"></span>` +
              `<span class="legend-name">${esc(model)}</span>` +
              `<span class="legend-value">${esc(row.display)}</span>` +
              `</div>`
            );
          })
          .join("") +
        `</div>`,
    )
    .join("");

  return `
    <div class="donut-wrap">
      <svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${segments}${centreLabel}</svg>
      <div class="legend">${legend}</div>
    </div>
  `;
}

function summaryCard(label: string, value: string, accent?: string): string {
  return `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value" ${
    accent ? `style="color:${accent}"` : ""
  }>${value}</div></div>`;
}

function projectSection(p: ProjectStats, config: CreditConfig): string {
  const modelRows =
    p.models.size > 0
      ? [...p.models.values()]
          .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))
          .map((m) => `<tr><td>${esc(m.model)}</td><td>${m.messages}</td><td>${fmtCompact(totalTokens(m.tokens))}</td><td>${fmtCost(m.cost)}</td></tr>`)
          .join("")
      : `<tr><td colspan="4" class="muted">No model usage recorded.</td></tr>`;

  const toolRows =
    p.toolCalls.size > 0
      ? mapToToolCallUsage(p.toolCalls)
          .map((t) => `<tr><td>${esc(t.tool)}</td><td>${fmtNumber(t.calls)}</td></tr>`)
          .join("")
      : `<tr><td colspan="2" class="muted">No tool-call data found.</td></tr>`;

  const sessionRows = p.sessions
    .map(
      (s) => `<tr${s.isSubagent ? ' class="subagent"' : ""}>
        <td>${s.isSubagent ? "↳ " : ""}${esc(s.title)}</td>
        <td>${fmtNumber(s.turnCount)}</td>
        <td>${fmtNumber(s.assistantMessageCount)}</td>
        <td>${fmtCompact(s.tokens.input)} / ${fmtCompact(s.tokens.output)}</td>
        <td>${fmtCompact(s.tokens.reasoning)}</td>
        <td>${fmtCompact(s.tokens.cacheRead)} / ${fmtCompact(s.tokens.cacheWrite)}</td>
        <td>${fmtNumber(sumToolCalls(s.toolCalls))}</td>
        <td>${fmtCredits(s.cost, config)}</td>
        <td>${fmtEffortMins(s.durationMs)}</td>
        <td>${fmtDate(s.updatedAt ?? s.createdAt)}</td>
      </tr>`,
    )
    .join("");

  return `
    <section class="project">
       <div class="project-heading">
         <h3>${esc(p.name)} ${p.worktree ? `<span class="muted mono small">${esc(p.worktree)}</span>` : ""}</h3>
         <span class="project-activity muted small">Last activity: ${fmtDate(p.lastActivity)}</span>
       </div>
      <div class="card-row">
        ${summaryCard("Sessions", fmtNumber(p.sessionCount))}
         ${summaryCard("User Turns", fmtNumber(p.turnCount))}
        ${summaryCard("Messages", fmtNumber(p.messageCount))}
        ${summaryCard("Tokens", fmtCompact(totalTokens(p.tokens)))}
        ${summaryCard("Total credits", fmtCredits(p.cost, config), "#15803d")}
        ${summaryCard("Total spent", fmtCost(p.cost), "#15803d")}
        ${summaryCard("Effort", fmtEffortHours(p.effortMs))}
      </div>
      <div class="grid-2">
        <div>
          <h4>By model</h4>
          <table><thead><tr><th>Model</th><th>Msgs</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${modelRows}</tbody></table>
        </div>
        <div>
          <h4>Tool calls</h4>
          <table><thead><tr><th>Tool</th><th>Calls</th></tr></thead><tbody>${toolRows}</tbody></table>
        </div>
      </div>
      <h4>Sessions</h4>
      <div class="table-scroll">
        <table class="sessions-table">
          <thead><tr>
            <th>Session</th><th>Turns</th><th>Replies</th><th>In / Out</th><th>Reasoning</th><th>Cache R/W</th><th>Tools</th><th>Credits</th><th>Effort</th><th>Last activity</th>
          </tr></thead>
          <tbody>${sessionRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/** Full, self-contained, "beautiful" HTML report with inline SVG charts — no external dependencies, opens offline. */
export function renderHtmlReport(stats: OverallStats, config: CreditConfig = DEFAULT_CREDIT_CONFIG): string {
  const tokensByProject = stats.projects
    .map((p) => ({ label: p.name, value: totalTokens(p.tokens), display: fmtCompact(totalTokens(p.tokens)) }));
  const costByProject = stats.projects
    .map((p) => ({ label: p.name, value: p.cost, display: fmtCost(p.cost) }));
  const tokensByModel = [...stats.models.values()]
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))
    .map((m) => ({ label: m.model, value: totalTokens(m.tokens), display: fmtCompact(totalTokens(m.tokens)) }));
  const toolCallRows = mapToToolCallUsage(stats.toolCalls)
    .slice(0, 12)
    .map((t) => ({ label: t.tool, value: t.calls, display: fmtNumber(t.calls) }));

  const projectsHtml = stats.projects.map((project) => projectSection(project, config)).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Velocity Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Teko:wght@600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg:      #f0f4f8;
    --panel:   #ffffff;
    --border:  #dde3ed;
    --text:    #1e293b;
    --muted:   #64748b;
    --accent:  #0369a1;
    --accent2: #7c3aed;
    --good:    #15803d;
    --warning: #b45309;
    --shadow-inset: inset 0 1px 0 rgba(255,255,255,0.85), inset 0 -1px 0 rgba(0,0,0,0.04);
    --gradient-surface: linear-gradient(170deg, #ffffff 0%, #f3f6fa 100%);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: var(--bg);
    background-image:
      radial-gradient(circle at 18% 10%, rgba(3,105,161,0.07) 0%, transparent 55%),
      radial-gradient(circle at 82% 90%, rgba(124,58,237,0.05) 0%, transparent 55%);
    color: var(--text);
    line-height: 1.5;
  }
  .wrap { max-width: 1320px; margin: 0 auto; padding: 0 0 80px; }
  header {
    position: relative;
    width: 100%;
    min-height: 90px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    margin-bottom: 48px;
    padding: 20px 28px 18px;
    overflow: hidden;
    border-radius: 0 0 24px 24px;
    box-shadow: 0 16px 40px rgba(15,23,42,0.20), 0 4px 10px rgba(15,23,42,0.12);
  }
  /* dark overlay so text is always readable over the background image */
  header::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(160deg, rgba(15,23,42,0.55) 0%, rgba(3,60,110,0.40) 100%);
    pointer-events: none;
  }
  /* top bevel highlight */
  header::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.30), transparent);
    z-index: 1;
  }
  header h1 {
    position: relative;
    z-index: 1;
    font-family: 'Teko', sans-serif;
    font-size: 80px;
    font-weight: 700;
    margin: 0;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #ffffff;
    text-shadow:
      0 2px 0 rgba(0,0,0,0.45),
      0 4px 14px rgba(0,0,0,0.35),
      0 0 40px rgba(56,189,248,0.20);
    line-height: 1;
  }
  header .meta {
    position: relative;
    z-index: 1;
    color: rgba(255,255,255,0.65);
    font-size: 13px;
    margin-top: 10px;
  }
  h2 {
    font-size: 12px;
    margin: 44px 0 16px;
    color: var(--accent);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h2::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, var(--border), transparent); }
  h2.projects-title { margin-bottom: 8px; }
  h2.projects-title + .project { margin-top: 8px; }
  h3 { font-size: 15px; margin: 0 0 14px; color: var(--text); font-weight: 600; }
  h4 { font-size: 11px; margin: 18px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 14px; margin-bottom: 10px; }
  .card {
    background: var(--gradient-surface);
    border: 1px solid rgba(255,255,255,0.9);
    border-radius: 16px;
    padding: 16px 20px;
    min-width: 0;
    position: relative;
    overflow: hidden;
    box-shadow:
      var(--shadow-inset),
      0 2px 4px rgba(15,23,42,0.05),
      0 8px 20px rgba(15,23,42,0.09),
      0 1px 0 rgba(255,255,255,1) inset;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 65%; height: 55%;
    background: radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.55) 0%, transparent 70%);
    pointer-events: none;
  }
  .card:hover {
    transform: translateY(-4px) scale(1.01);
    box-shadow:
      var(--shadow-inset),
      0 6px 14px rgba(15,23,42,0.08),
      0 20px 48px rgba(15,23,42,0.13);
  }
  .card-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; font-weight: 600; }
  .card-value { font-size: 22px; font-weight: 700; color: var(--text); }
  .panel {
    background: var(--gradient-surface);
    border: 1px solid rgba(255,255,255,0.85);
    border-radius: 20px;
    padding: 22px 26px;
    margin-bottom: 20px;
    min-width: 0;
    height: 100%;
    position: relative;
    overflow: hidden;
    box-shadow:
      var(--shadow-inset),
      0 4px 8px rgba(15,23,42,0.05),
      0 12px 32px rgba(15,23,42,0.09),
      0 32px 64px rgba(15,23,42,0.06);
    transition: transform 0.20s ease, box-shadow 0.20s ease;
  }
  .panel::before {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 42%;
    background: linear-gradient(180deg, rgba(255,255,255,0.48) 0%, transparent 100%);
    border-radius: 20px 20px 0 0;
    pointer-events: none;
  }
  .panel:hover {
    transform: translateY(-5px);
    box-shadow:
      var(--shadow-inset),
      0 6px 14px rgba(15,23,42,0.07),
      0 20px 50px rgba(15,23,42,0.13),
      0 48px 88px rgba(15,23,42,0.07);
  }
  .most-active { margin-top: 32px; }
  .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: stretch; }
  @media (max-width: 720px) { .grid-2 { grid-template-columns: 1fr; } }
  @media (max-width: 520px) { .donut-wrap { grid-template-columns: 1fr; } }
  .chart { display: block; width: 100%; height: auto; min-height: 120px; overflow: visible; }
  .bar-label { fill: var(--muted); }
  .bar-value { fill: var(--text); font-weight: 700; }
  .donut-wrap { display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 18px; width: 100%; }
  .donut-wrap > svg { width: 100%; height: auto; display: block; align-self: center; }
  .legend { display: flex; flex-direction: column; justify-content: center; gap: 12px; min-width: 0; font-size: 14px; align-self: center; }
  .legend-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .legend-provider { color: var(--text); font-weight: 700; overflow-wrap: anywhere; }
  .legend-item { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 8px; }
  .legend-swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; display: inline-block; }
  .legend-name { color: var(--text); min-width: 0; overflow-wrap: anywhere; padding-left: 12px; }
  .legend-value { color: var(--muted); font-weight: 600; text-align: right; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .sessions-table { min-width: 1060px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; color: var(--text); }
  th { color: var(--muted); font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; background: rgba(241,245,249,0.7); }
  tr.subagent td { color: var(--muted); font-size: 12px; }
  tr.subagent td:first-child { padding-left: 30px; }
  tr:hover td { background: rgba(3, 105, 161, 0.04); }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .small { font-size: 12px; }
  .project-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .project-heading h3 { min-width: 0; }
  .project-activity { flex-shrink: 0; white-space: nowrap; }
  .table-scroll { overflow-x: auto; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--border); }
  .project { border-top: 1px solid var(--border); padding-top: 32px; margin-top: 32px; }
  .highlight {
    border: 1px solid rgba(180, 83, 9, 0.25);
    background: linear-gradient(145deg, rgba(255,237,213,0.82) 0%, rgba(255,255,255,0.72) 100%);
  }
  .highlight::before { background: linear-gradient(180deg, rgba(255,255,255,0.55) 0%, transparent 100%); }
  .highlight h3 { color: var(--warning); }
  @media (max-width: 720px) { .project-heading { align-items: flex-start; flex-direction: column; gap: 4px; } }
  footer { margin-top: 64px; color: var(--muted); font-size: 12px; text-align: center; }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap" style="max-width:1320px;margin:0 auto;padding:0 28px 80px;">
  <header style="${(() => { const uri = headerImageDataUri(); return uri ? `background-image: url('${uri}');` : ''; })()}">
    <h1>Velocity Report</h1>
    <div class="meta">Generated: ${esc(new Date(stats.generatedAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }))} · Date Range: ${esc(formatDateRange(stats.dateRange))}</div>
  </header>

  <h2>Summary</h2>
  <div class="card-row">
    ${summaryCard("Projects", fmtNumber(stats.projectCount))}
    ${summaryCard("Sessions", fmtNumber(stats.sessionCount))}
    ${summaryCard("User Turns", fmtNumber(stats.turnCount))}
    ${summaryCard("Messages", fmtNumber(stats.messageCount))}
    ${summaryCard("Total tokens", fmtCompact(totalTokens(stats.tokens)))}
    ${summaryCard("Total credits", fmtCredits(stats.cost, config), "#15803d")}
    ${summaryCard("Total spent", fmtCost(stats.cost), "#15803d")}
  </div>

  <h2>Averages</h2>
  <div class="card-row average-cards">
    ${summaryCard("Tokens / session", fmtCompact(stats.averages.tokensPerSession))}
    ${summaryCard("Credits / session", fmtCredits(stats.averages.costPerSession, config))}
    ${summaryCard("Messages / session", stats.averages.messagesPerSession.toFixed(1))}
    ${summaryCard("Tokens / message", fmtCompact(stats.averages.tokensPerMessage))}
    ${summaryCard("Credits / message", fmtCredits(stats.averages.costPerMessage, config))}
    ${summaryCard("Tokens / project", fmtCompact(stats.averageTokensPerProject))}
    ${summaryCard("Credits / project", fmtCredits(stats.averageCostPerProject, config))}
    ${summaryCard("Sessions / project", stats.averageSessionsPerProject.toFixed(1))}
  </div>

  ${
    stats.mostActiveProject
       ? `<div class="panel highlight most-active">
          <h3>🏆 Most active project: ${esc(stats.mostActiveProject.name)}</h3>
          <div class="card-row">
            ${summaryCard("Sessions", fmtNumber(stats.mostActiveProject.sessionCount))}
             ${summaryCard("User Turns", fmtNumber(stats.mostActiveProject.turnCount))}
            ${summaryCard("Tokens", fmtCompact(totalTokens(stats.mostActiveProject.tokens)))}
            ${summaryCard("Total credits", fmtCredits(stats.mostActiveProject.cost, config), "#15803d")}
            ${summaryCard("Total spent", fmtCost(stats.mostActiveProject.cost), "#15803d")}
             ${summaryCard("Effort", fmtEffortHours(stats.mostActiveProject.effortMs))}
          </div>
        </div>`
      : ""
  }

  <h2>Charts</h2>
  <div class="grid-2">
    <div class="panel">
      <h3>Tokens by project</h3>
      ${tokensByProject.length > 0 ? horizontalBarChart(tokensByProject) : `<p class="muted">No data.</p>`}
    </div>
    <div class="panel">
      <h3>Cost by project</h3>
      ${costByProject.length > 0 ? horizontalBarChart(costByProject, { colorFn: () => "#15803d" }) : `<p class="muted">No data.</p>`}
    </div>
    <div class="panel">
      <h3>Token usage by model</h3>
      ${tokensByModel.length > 0 ? donutChart(tokensByModel) : `<p class="muted">No model usage recorded.</p>`}
    </div>
    <div class="panel">
      <h3>Tool calls</h3>
      ${
        stats.toolCallsTracked && toolCallRows.length > 0
          ? horizontalBarChart(toolCallRows, { colorFn: () => "#7c3aed" })
          : `<p class="muted">No tool-call data found. Your opencode version may not be persisting message parts, or this dashboard is reading a data source that doesn't expose them.</p>`
      }
    </div>
  </div>

  <h2 class="projects-title">Projects</h2>
  ${projectsHtml}

  <footer>Generated by <a href="https://www.npmjs.com/package/@godaravikas/opencode-velocity" target="_blank" rel="noopener noreferrer">@godaravikas/opencode-velocity v${esc(pkg.version)}</a> · Source: ${esc(stats.dataDir)} · Credit rate: ${esc(fmtCost(config.dollarsPerCredit))} / credit</footer>
</div>
</body>
</html>`;
}

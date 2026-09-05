// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { mapToToolCallUsage, sumToolCalls, type ModelUsage, type OverallStats, type ProjectStats, type SessionStats, type TokenTotals } from "./types.ts";
import { creditsFromCost, DEFAULT_CREDIT_CONFIG, type CreditConfig } from "./credits.ts";

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined;
function c(code: string, s: string): string {
  return USE_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s;
}
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const cyan = (s: string) => c("36", s);
const yellow = (s: string) => c("33", s);
const green = (s: string) => c("32", s);

export function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtCredits(cost: number, config: CreditConfig = DEFAULT_CREDIT_CONFIG): string {
  return fmtNumber(creditsFromCost(cost, config));
}

export function fmtDate(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function totalTokens(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

function box(title: string, rows: string[][], widths?: number[]): string {
  const colWidths =
    widths ??
    rows.reduce<number[]>((acc, row) => {
      row.forEach((cell, i) => {
        acc[i] = Math.max(acc[i] ?? 0, stripAnsi(cell).length);
      });
      return acc;
    }, []);
  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + (colWidths.length - 1) * 3 + 2;
  const line = (ch: string) => ch.repeat(totalWidth);
  const out: string[] = [];
  out.push(dim(`+${line("-")}+`));
  out.push(`${dim("|")} ${bold(title.padEnd(totalWidth - 2))} ${dim("|")}`);
  out.push(dim(`+${line("-")}+`));
  for (const row of rows) {
    const padded = row.map((cell, i) => padVisible(cell, colWidths[i] ?? 0)).join("   ");
    out.push(`${dim("|")} ${padded.padEnd(totalWidth - 2)} ${dim("|")}`);
  }
  out.push(dim(`+${line("-")}+`));
  return out.join("\n");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function padVisible(s: string, width: number): string {
  const visibleLen = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visibleLen));
}

function modelBreakdownRows(models: Map<string, ModelUsage>): string[][] {
  return [...models.values()]
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))
    .map((m) => [m.model, `${m.messages}`, fmtCompact(totalTokens(m.tokens)), fmtCost(m.cost)]);
}

function toolCallRows(toolCalls: Map<string, number>): string[][] {
  return mapToToolCallUsage(toolCalls).map((t) => [t.tool, fmtNumber(t.calls)]);
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)));
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const headerLine = header.map((h, i) => padVisible(bold(h), widths[i])).join(" | ");
  const bodyLines = rows.map((r) => r.map((cell, i) => padVisible(cell, widths[i])).join(" | "));
  return [headerLine, sep, ...bodyLines].join("\n");
}

export function renderOverviewReport(stats: OverallStats, opts: { topProjects?: number; creditConfig?: CreditConfig } = {}): string {
  const topN = opts.topProjects ?? stats.projects.length;
  const creditConfig = opts.creditConfig ?? DEFAULT_CREDIT_CONFIG;
  const out: string[] = [];

  out.push(bold(cyan("▍ opencode · Velocity — Project Stats")));
  out.push(dim(`data dir: ${stats.dataDir}`));
  out.push(dim(`generated: ${fmtDate(stats.generatedAt)}`));
  out.push("");

  out.push(
    box("SUMMARY (all projects)", [
      ["Projects", fmtNumber(stats.projectCount)],
      ["Sessions", fmtNumber(stats.sessionCount)],
      ...(stats.subagentCount > 0 ? [["Subagents", fmtNumber(stats.subagentCount)]] : []),
       ["User Turns", fmtNumber(stats.turnCount)],
      ["Messages", fmtNumber(stats.messageCount)],
      ["Total tokens", fmtCompact(totalTokens(stats.tokens))],
      ["  input / output", `${fmtCompact(stats.tokens.input)} / ${fmtCompact(stats.tokens.output)}`],
      ["  reasoning", fmtCompact(stats.tokens.reasoning)],
      ["  cache read / write", `${fmtCompact(stats.tokens.cacheRead)} / ${fmtCompact(stats.tokens.cacheWrite)}`],
      ["Total credits", green(fmtCredits(stats.cost, creditConfig))],
    ]),
  );
  out.push("");

  out.push(
    box("AVERAGES", [
      ["Tokens / session", fmtCompact(stats.averages.tokensPerSession)],
      ["Credits / session", fmtCredits(stats.averages.costPerSession, creditConfig)],
      ["Messages / session", stats.averages.messagesPerSession.toFixed(1)],
      ["Tokens / message", fmtCompact(stats.averages.tokensPerMessage)],
      ["Credits / message", fmtCredits(stats.averages.costPerMessage, creditConfig)],
      ["Tokens / project", fmtCompact(stats.averageTokensPerProject)],
      ["Credits / project", fmtCredits(stats.averageCostPerProject, creditConfig)],
      ["Sessions / project", stats.averageSessionsPerProject.toFixed(1)],
    ]),
  );
  out.push("");

  if (stats.models.size > 0) {
    out.push(box("TOKEN USAGE BY MODEL", [["Model", "Msgs", "Tokens", "Cost"], ...modelBreakdownRows(stats.models)]));
    out.push("");
  }

  if (stats.toolCallsTracked && stats.toolCalls.size > 0) {
    out.push(box("TOOL CALLS", [["Tool", "Calls"], ...toolCallRows(stats.toolCalls)]));
    out.push("");
  } else {
    out.push(dim("(No tool-call data found — your opencode version may not be persisting message parts locally.)"));
    out.push("");
  }

  if (stats.mostActiveProject) {
    const p = stats.mostActiveProject;
    out.push(
      box(`⭐ MOST ACTIVE PROJECT: ${p.name}`, [
        ["Sessions", fmtNumber(p.sessionCount)],
        ...(p.subagentCount > 0 ? [["Subagents", fmtNumber(p.subagentCount)]] : []),
         ["User Turns", fmtNumber(p.turnCount)],
        ["Messages", fmtNumber(p.messageCount)],
        ["Tokens", fmtCompact(totalTokens(p.tokens))],
        ["Total credits", green(fmtCredits(p.cost, creditConfig))],
        ["AVG credits / session", fmtCredits(p.averages.costPerSession, creditConfig)],
        ["Last activity", fmtDate(p.lastActivity)],
        ...(p.worktree ? [["Worktree", p.worktree]] : []),
      ]),
    );
    out.push("");
  }

  out.push(bold(yellow(`PROJECTS (ranked by token volume, top ${Math.min(topN, stats.projects.length)})`)));
  const rows = stats.projects.slice(0, topN).map((p, i) => [
    `${i + 1}.`,
    p.name,
    fmtNumber(p.sessionCount),
    fmtNumber(p.turnCount),
    fmtNumber(p.messageCount),
    fmtCompact(totalTokens(p.tokens)),
     fmtCredits(p.cost, creditConfig),
    fmtDate(p.lastActivity),
  ]);
    out.push(renderTable(["#", "Project", "Sessions", "User Turns", "Msgs", "Tokens", "Credits", "Last activity"], rows));

  return out.join("\n");
}

export function renderProjectDetail(project: ProjectStats, creditConfig: CreditConfig = DEFAULT_CREDIT_CONFIG): string {
  const out: string[] = [];
  out.push(bold(cyan(`▍ Project: ${project.name}`)));
  if (project.worktree) out.push(dim(project.worktree));
  out.push("");
  out.push(
    box("PROJECT SUMMARY", [
      ["Sessions", fmtNumber(project.sessionCount)],
      ...(project.subagentCount > 0 ? [["Subagents", fmtNumber(project.subagentCount)]] : []),
       ["User Turns", fmtNumber(project.turnCount)],
      ["Messages", fmtNumber(project.messageCount)],
      ["Tokens", fmtCompact(totalTokens(project.tokens))],
      ["  input / output", `${fmtCompact(project.tokens.input)} / ${fmtCompact(project.tokens.output)}`],
      ["  reasoning", fmtCompact(project.tokens.reasoning)],
      ["  cache read / write", `${fmtCompact(project.tokens.cacheRead)} / ${fmtCompact(project.tokens.cacheWrite)}`],
      ["Total credits", green(fmtCredits(project.cost, creditConfig))],
      ["First activity", fmtDate(project.firstActivity)],
      ["Last activity", fmtDate(project.lastActivity)],
    ]),
  );
  out.push("");
  out.push(
    box("AVERAGES", [
      ["Tokens / session", fmtCompact(project.averages.tokensPerSession)],
       ["AVG credits / session", fmtCredits(project.averages.costPerSession, creditConfig)],
      ["Messages / session", project.averages.messagesPerSession.toFixed(1)],
      ["Tokens / message", fmtCompact(project.averages.tokensPerMessage)],
       ["Credits / message", fmtCredits(project.averages.costPerMessage, creditConfig)],
    ]),
  );
  out.push("");
  if (project.models.size > 0) {
    out.push(box("BY MODEL", [["Model", "Msgs", "Tokens", "Cost"], ...modelBreakdownRows(project.models)]));
    out.push("");
  }
  if (project.toolCalls.size > 0) {
    out.push(box("TOOL CALLS", [["Tool", "Calls"], ...toolCallRows(project.toolCalls)]));
    out.push("");
  }
  out.push(bold(yellow("SESSIONS")));
  const rows = project.sessions.map((s: SessionStats) => [
    s.isSubagent ? `  ↳ ${s.title}` : s.title,
    fmtNumber(s.turnCount),
    fmtNumber(s.assistantMessageCount),
    fmtCompact(s.tokens.input),
    fmtCompact(s.tokens.output),
    fmtCompact(s.tokens.reasoning),
    `${fmtCompact(s.tokens.cacheRead)}/${fmtCompact(s.tokens.cacheWrite)}`,
    fmtNumber(sumToolCalls(s.toolCalls)),
     fmtCredits(s.cost, creditConfig),
    fmtDate(s.updatedAt ?? s.createdAt),
  ]);
  out.push(
    renderTable(
      ["Session", "Turns", "Replies", "In", "Out", "Reason.", "Cache R/W", "Tools", "Credits", "Last activity"],
      rows,
    ),
  );
  return out.join("\n");
}

/** Full multi-section Markdown report, suitable for writing to a file. */
export function renderMarkdownReport(stats: OverallStats, creditConfig: CreditConfig = DEFAULT_CREDIT_CONFIG): string {
  const out: string[] = [];
  out.push(`# Velocity Report`);
  out.push("");
  out.push(`_Generated ${new Date(stats.generatedAt).toISOString()} from \`${stats.dataDir}\`_`);
  out.push("");
  out.push(`## Summary`);
  out.push("");
  out.push(`| Metric | Value |`);
  out.push(`| --- | --- |`);
  out.push(`| Projects | ${fmtNumber(stats.projectCount)} |`);
  out.push(`| Sessions | ${fmtNumber(stats.sessionCount)} |`);
  if (stats.subagentCount > 0) out.push(`| Subagents | ${fmtNumber(stats.subagentCount)} |`);
  out.push(`| User Turns | ${fmtNumber(stats.turnCount)} |`);
  out.push(`| Messages | ${fmtNumber(stats.messageCount)} |`);
  out.push(`| Total tokens | ${fmtNumber(totalTokens(stats.tokens))} |`);
  out.push(`| Input tokens | ${fmtNumber(stats.tokens.input)} |`);
  out.push(`| Output tokens | ${fmtNumber(stats.tokens.output)} |`);
  out.push(`| Reasoning tokens | ${fmtNumber(stats.tokens.reasoning)} |`);
  out.push(`| Cache read tokens | ${fmtNumber(stats.tokens.cacheRead)} |`);
  out.push(`| Cache write tokens | ${fmtNumber(stats.tokens.cacheWrite)} |`);
  out.push(`| **Total credits** | **${fmtCredits(stats.cost, creditConfig)}** |`);
  out.push("");

  out.push(`## Averages`);
  out.push("");
  out.push(`| Metric | Value |`);
  out.push(`| --- | --- |`);
  out.push(`| Tokens / session | ${fmtNumber(stats.averages.tokensPerSession)} |`);
  out.push(`| Credits / session | ${fmtCredits(stats.averages.costPerSession, creditConfig)} |`);
  out.push(`| Messages / session | ${stats.averages.messagesPerSession.toFixed(1)} |`);
  out.push(`| Tokens / message | ${fmtNumber(stats.averages.tokensPerMessage)} |`);
  out.push(`| Credits / message | ${fmtCredits(stats.averages.costPerMessage, creditConfig)} |`);
  out.push(`| Tokens / project | ${fmtNumber(stats.averageTokensPerProject)} |`);
  out.push(`| Credits / project | ${fmtCredits(stats.averageCostPerProject, creditConfig)} |`);
  out.push(`| Sessions / project | ${stats.averageSessionsPerProject.toFixed(1)} |`);
  out.push("");

  out.push(`## Token usage by model`);
  out.push("");
  if (stats.models.size > 0) {
    out.push(`| Model | Messages | Tokens | Cost |`);
    out.push(`| --- | ---: | ---: | ---: |`);
    for (const [, m] of [...stats.models.entries()].sort((a, b) => totalTokens(b[1].tokens) - totalTokens(a[1].tokens))) {
      out.push(`| ${m.model} | ${m.messages} | ${fmtNumber(totalTokens(m.tokens))} | ${fmtCost(m.cost)} |`);
    }
  } else {
    out.push(`_No model usage recorded._`);
  }
  out.push("");

  out.push(`## Tool calls`);
  out.push("");
  if (stats.toolCallsTracked && stats.toolCalls.size > 0) {
    out.push(`| Tool | Calls |`);
    out.push(`| --- | ---: |`);
    for (const t of mapToToolCallUsage(stats.toolCalls)) {
      out.push(`| ${t.tool} | ${t.calls} |`);
    }
  } else {
    out.push(`_No tool-call data found. Your opencode version may not persist message parts to local storage the way this tool expects — see src/types.ts (RawPartFile) for details._`);
  }
  out.push("");

  if (stats.mostActiveProject) {
    const p = stats.mostActiveProject;
    out.push(
      `## ⭐ Most Active Project: ${p.name}`);
    out.push("");
    out.push(
       `${fmtNumber(p.sessionCount)} sessions${p.subagentCount > 0 ? ` · ${fmtNumber(p.subagentCount)} subagents` : ""} · ${fmtNumber(p.turnCount)} User Turns · ${fmtNumber(
        p.messageCount,
       )} messages · ${fmtNumber(totalTokens(p.tokens))} tokens · ${fmtCredits(p.cost, creditConfig)} credits · last active ${fmtDate(
        p.lastActivity,
      )}`,
    );
    out.push("");
  }

  out.push(`## Projects`);
  out.push("");
  out.push(`| # | Project | Sessions | User Turns | Messages | Tokens | Cost | Last activity |`);
  out.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |`);
  stats.projects.forEach((p, i) => {
    out.push(
      `| ${i + 1} | ${p.name} | ${p.sessionCount} | ${p.turnCount} | ${p.messageCount} | ${fmtNumber(
        totalTokens(p.tokens),
        )} | ${fmtCredits(p.cost, creditConfig)} | ${fmtDate(p.lastActivity)} |`,
    );
  });
  out.push("");

  for (const p of stats.projects) {
    out.push(`### ${p.name}`);
    if (p.worktree) out.push(`\`${p.worktree}\``);
    out.push("");
    out.push(
       `${fmtNumber(p.sessionCount)} sessions${p.subagentCount > 0 ? ` · ${fmtNumber(p.subagentCount)} subagents` : ""} · ${fmtNumber(p.turnCount)} user turns · ${fmtNumber(p.messageCount)} messages · ` +
        `avg ${fmtNumber(p.averages.tokensPerSession)} tok/session · avg ${fmtCost(p.averages.costPerSession)}/session`,
    );
    out.push("");

    if (p.models.size > 0) {
      out.push(`**By model:**`);
      out.push("");
      out.push(`| Model | Messages | Tokens | Cost |`);
      out.push(`| --- | ---: | ---: | ---: |`);
      for (const [, m] of [...p.models.entries()].sort((a, b) => totalTokens(b[1].tokens) - totalTokens(a[1].tokens))) {
        out.push(`| ${m.model} | ${m.messages} | ${fmtNumber(totalTokens(m.tokens))} | ${fmtCost(m.cost)} |`);
      }
      out.push("");
    }

    if (p.toolCalls.size > 0) {
      out.push(`**Tool calls:**`);
      out.push("");
      out.push(`| Tool | Calls |`);
      out.push(`| --- | ---: |`);
      for (const t of mapToToolCallUsage(p.toolCalls)) {
        out.push(`| ${t.tool} | ${t.calls} |`);
      }
      out.push("");
    }

    out.push(`**Sessions:**`);
    out.push("");
    out.push(
      `| Session | Turns | Replies | Input | Output | Reasoning | Cache R/W | Tool calls | Credits | Last activity |`,
    );
    out.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const s of p.sessions) {
      const label = s.isSubagent ? `↳ ${s.title}` : s.title;
      out.push(
        `| ${label} | ${s.turnCount} | ${s.assistantMessageCount} | ${fmtNumber(
          s.tokens.input,
        )} | ${fmtNumber(s.tokens.output)} | ${fmtNumber(s.tokens.reasoning)} | ${fmtNumber(
          s.tokens.cacheRead,
         )} / ${fmtNumber(s.tokens.cacheWrite)} | ${sumToolCalls(s.toolCalls)} | ${fmtCredits(s.cost, creditConfig)} | ${fmtDate(
          s.updatedAt ?? s.createdAt,
        )} |`,
      );
    }
    out.push("");
  }

  return out.join("\n");
}

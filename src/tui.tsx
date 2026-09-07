// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
/**
 * opencode TUI plugin — /velocity command.
 *
 * Registers a full-screen route showing cross-project token/cost/session
 * report. Follows the same plugin pattern as opencode-vacuum.
 *
 * Registers as a TUI plugin in tui.json:
 *   ~/.config/opencode/tui.json
 *     { "plugin": ["opencode-velocity/tui"] }
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import pkg from "../package.json" with { type: "json" };
const VERSION = pkg.version;
import { createSignal, For, Show } from "solid-js";
import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { TuiPluginApi, TuiRouteCurrent, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { buildStatsFromDb } from "./db-source.ts";
import { buildStatsFromSdk } from "./sdk-source.ts";
import type { MinimalSdkClient } from "./sdk-source.ts";
import { renderHtmlReport } from "./html-report.ts";
import { dateToInput, formatDateRange } from "./date-range.ts";
import { creditsFromCost, loadCreditConfig, saveCreditConfig, DEFAULT_CREDIT_CONFIG, type CreditConfig } from "./credits.ts";
import { fmtCompact, fmtCost, fmtDate, fmtNumber } from "./format.ts";
import type { DateRange, OverallStats, ProjectStats, SessionStats } from "./types.ts";

function debugLog(msg: string) {
  try {
    const dir = join(process.env.HOME ?? "~", ".local", "share", "opencode", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "velocity-debug.log"), msg + "\n", { flag: "a" });
  } catch {}
}

const ROUTE = "velocity";

function totalTokens(t: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

function sumToolCalls(m: Map<string, number>): number {
  let total = 0;
  for (const v of m.values()) total += v;
  return total;
}

function fmtCredits(cost: number, config: CreditConfig): string {
  return fmtNumber(creditsFromCost(cost, config));
}

function fmtEffortHours(ms: number): string {
  if (ms <= 0) return "—";
  const h = ms / 3_600_000;
  return h < 0.1 ? "<0.1h" : `${h.toFixed(1)}h`;
}

function fmtEffortMins(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return "—";
  const m = ms / 60_000;
  return m < 1 ? "<1m" : `${Math.round(m)}m`;
}

function calendarMonthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function calendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function parseInputDate(value: string): Date {
  return new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
}

// Calendar grid geometry. The 7 day columns are a fixed width so the grid
// stays aligned; the dialog frame supplies the surrounding width and centering.
const CELL_WIDTH = 5;
const CAL_WIDTH = CELL_WIDTH * 7; // 35
const CAL_ROWS = [0, 1, 2, 3, 4, 5];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * Selection state for the date filter dialog.
 *
 * Created *outside* the `api.ui.dialog.replace` render thunk on purpose: the
 * dialog host may re-invoke that thunk (theme change, resize, stack update),
 * which re-mounts the component. Keeping the signals out here means a re-mount
 * no longer wipes the half-finished start/end selection.
 */
function createDateFilterState(initialRange?: DateRange) {
  const anchor = initialRange ? parseInputDate(initialRange.start) : new Date();
  const [month, setMonth] = createSignal(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const [start, setStart] = createSignal<string | undefined>(initialRange?.start);
  const [end, setEnd] = createSignal<string | undefined>(initialRange?.end);
  return { month, setMonth, start, setStart, end, setEnd };
}

type DateFilterState = ReturnType<typeof createDateFilterState>;

interface DateFilterDialogProps {
  api: TuiPluginApi;
  state: DateFilterState;
  onApply: (range?: DateRange) => void;
}

function DateFilterDialog(props: DateFilterDialogProps) {
  const { month, setMonth, start, setStart, end, setEnd } = props.state;
  const days = () => calendarDays(month());
  const theme = () => props.api.theme.current;

  const selectDay = (day: Date) => {
    const value = dateToInput(day);
    if (!start() || end()) {
      // No range yet, or the previous range is complete: begin a new one.
      setStart(value);
      setEnd(undefined);
    } else if (value < start()!) {
      // Clicked before the anchor: the anchor becomes the end.
      setEnd(start());
      setStart(value);
    } else {
      setEnd(value);
    }
  };

  const apply = () => {
    if (!start()) {
      props.onApply(undefined);
      return;
    }
    props.onApply({ start: start()!, end: end() ?? start()! });
  };

  const click = (action: () => void) => (event: TuiMouseEvent) => {
    if (event.button === 0) {
      event.stopPropagation();
      action();
    }
  };

  const shiftMonth = (delta: number) =>
    setMonth(new Date(month().getFullYear(), month().getMonth() + delta, 1));

  return (
    // NOTE: do NOT wrap this in `<props.api.ui.Dialog>`. The dialog stack
    // (driven by `api.ui.dialog.replace()`, see openFilterDialog below)
    // already renders whatever we return here inside opencode's single
    // global dialog frame — the full-screen scrim, the centered fixed-width
    // panel, all of it. `api.ui.Dialog` is a SEPARATE, second instance of
    // that same frame component. Wrapping our own content in it stacked two
    // full-screen absolute overlays on top of each other: two translucent
    // black scrims composited (looking like one dark, wrong-toned backdrop)
    // and a second independently-centered fixed-width panel nested inside
    // the first, which is why the calendar looked mis-centered. Every
    // built-in dialog (DialogPrompt, DialogConfirm, ...) returns a bare
    // box tree for the same reason — the host already provides the frame.
    <box paddingLeft={2} paddingRight={2} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text style={{ fg: theme().text }}>Filter report by date</text>
        <text style={{ fg: theme().textMuted }} onMouseUp={() => props.api.ui.dialog.clear()}>esc</text>
      </box>
      {/* Centering wrapper — the grid is a fixed CAL_WIDTH, the frame is not. */}
      <box alignItems="center" marginTop={1}>
        <box width={CAL_WIDTH} flexDirection="column">
          <box flexDirection="row">
            <box width={9} onMouseDown={click(() => shiftMonth(-1))}>
              <text style={{ fg: theme().textMuted }}>‹ Prev</text>
            </box>
            <box width={17} alignItems="center">
              <text style={{ fg: theme().text }}>{calendarMonthLabel(month())}</text>
            </box>
            <box width={9} alignItems="flex-end" onMouseDown={click(() => shiftMonth(1))}>
              <text style={{ fg: theme().textMuted }}>Next ›</text>
            </box>
          </box>
          <box flexDirection="row">
            <For each={WEEKDAYS}>
              {(day) => (
                <box width={CELL_WIDTH} alignItems="center">
                  <text style={{ fg: theme().textMuted }}>{day}</text>
                </box>
              )}
            </For>
          </box>
          <For each={CAL_ROWS}>
            {(row) => (
              <box flexDirection="row">
                <For each={days().slice(row * 7, row * 7 + 7)}>
                  {(day) => {
                    // These MUST be accessors, not consts. `For` runs this
                    // factory inside an untracked `createRoot`, so a plain
                    // const would snapshot the selection at first render and
                    // never update.
                    const value = dateToInput(day);
                    const inMonth = () => day.getMonth() === month().getMonth();
                    const selected = () => value === start() || value === end();
                    const between = () => Boolean(start() && end() && value > start()! && value < end()!);
                    // `undefined` keeps the dialog frame's own background
                    // showing through instead of painting a black block.
                      const background = () =>
                        selected() ? theme().accent : between() ? theme().backgroundElement : undefined;
                      const foreground = () =>
                        selected() ? theme().selectedListItemText : inMonth() ? theme().text : theme().textMuted;
                      return (
                        <box
                          width={CELL_WIDTH}
                          onMouseDown={click(() => selectDay(day))}
                          backgroundColor={background()}
                          alignItems="center"
                        >
                          <text style={{ fg: foreground(), bg: background() }}>
                            {String(day.getDate()).padStart(2, " ")}
                          </text>
                        </box>
                      );
                    }}
                  </For>
                </box>
              )}
            </For>
          </box>
        </box>
      <box flexDirection="row" justifyContent="space-between" marginTop={1} paddingBottom={1}>
        <text style={{ fg: theme().textMuted }} onMouseUp={() => { setStart(undefined); setEnd(undefined); }}>
          Clear
        </text>
        <text style={{ fg: theme().textMuted }}>
          {start() ? `${start()} → ${end() ?? start()}` : "All Available Data"}
        </text>
        <text style={{ fg: theme().accent }} onMouseUp={apply}>Apply</text>
      </box>
    </box>
  );
}

export function formatReportTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

interface GroupedSession {
  parent: SessionStats;
  children: SessionStats[];
}

export function countProjectsWithSessions(projects: ProjectStats[]): number {
  return projects.filter((project) => project.sessions.length > 0).length;
}

function groupSessions(sessions: SessionStats[]): GroupedSession[] {
  const byId = new Map<string, SessionStats>();
  for (const s of sessions) byId.set(s.id, s);
  const childrenOf = new Map<string, SessionStats[]>();
  for (const s of sessions) {
    if (s.parentID && byId.has(s.parentID)) {
      const arr = childrenOf.get(s.parentID);
      if (arr) arr.push(s);
      else childrenOf.set(s.parentID, [s]);
    }
  }
  return sessions
    .filter((s) => !s.parentID)
    .map((parent) => ({ parent, children: childrenOf.get(parent.id) ?? [] }));
}

function headline(stats: OverallStats): string {
  const top = stats.mostActiveProject;
  const base = `${countProjectsWithSessions(stats.projects)} projects · ${stats.sessionCount} sessions · ${stats.turnCount} User Turns · ${fmtCompact(
    totalTokens(stats.tokens),
  )} tokens · ${fmtCost(stats.cost)}`;
  return top ? `${base} — most active: ${top.name}` : base;
}

/** Write a self-contained HTML report with charts to the project directory. */
export function downloadVelocityReport(stats: OverallStats, projectDir?: string, creditConfig?: CreditConfig): string {
  const outDir = projectDir || cwd();
  debugLog(`[velocity] download: outDir=${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const stamp = formatReportTimestamp(new Date());
  const outPath = join(outDir, `velocity-${stamp}.html`);
  writeFileSync(outPath, renderHtmlReport(stats, creditConfig ?? DEFAULT_CREDIT_CONFIG));
  const size = statSync(outPath).size;
  debugLog(`[velocity] download: wrote ${outPath} (${size} bytes)`);
  return outPath;
}

export const tui: TuiPlugin = async (api) => {
  // ── Stats data ──────────────────────────────────────────────────────────
  const [stats, setStats] = createSignal<OverallStats | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [selectedProject, setSelectedProject] = createSignal<string | null>(null);
  const [downloadMessage, setDownloadMessage] = createSignal<string | null>(null);
  const [dateRange, setDateRange] = createSignal<DateRange | undefined>();
  const [creditConfig, setCreditConfig] = createSignal<CreditConfig>(loadCreditConfig());
  let returnRoute: TuiRouteCurrent = { name: "home" };

  const fetchStats = async (range = dateRange()) => {
    setLoading(true);
    setLoadError(null);
    try {
      try {
        // Use OpenCode's resolved state path instead of the plugin process
        // environment, which may point at the current project only.
        const dataDir = api.state.path.state || undefined;
        debugLog(`[velocity] loading global DB report from ${dataDir ?? "default data directory"}`);
        const dbStats = await buildStatsFromDb(dataDir, { dateRange: range });
        if (!range && dbStats.sessionCount === 0) {
          throw new Error("OpenCode database returned no sessions");
        }
        setStats(dbStats);
      } catch (dbError: any) {
        debugLog(`[velocity] DB unavailable; falling back to API: ${dbError?.message ?? dbError}`);
        try {
          setStats(await buildStatsFromSdk(api.client as unknown as MinimalSdkClient, { dateRange: range }));
        } catch (apiError: any) {
          setLoadError(apiError?.message ?? dbError?.message ?? "Failed to load stats");
          setStats(null);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const openFilterDialog = () => {
    // State is built here, outside the render thunk, so a re-render of the
    // dialog stack does not reset a half-finished start/end selection.
    const state = createDateFilterState(dateRange());
    api.ui.dialog.setSize("medium");
    api.ui.dialog.replace(() => (
      <DateFilterDialog
        api={api}
        state={state}
        onApply={(nextRange) => {
          setDateRange(nextRange);
          api.ui.dialog.clear();
          fetchStats(nextRange);
        }}
      />
    ));
  };

  // ── Keymap layer — registered only while on the velocity route ──────────
  let unregisterNav: (() => void) | undefined;

  const NAV_LAYER = {
    mode: "base",
    commands: [
      {
        name: "velocity.close",
        title: "Close",
        run() { closeDashboard(); },
      },
      {
        name: "velocity.back",
        title: "Back to overview",
        run() { setSelectedProject(null); },
      },
      {
        name: "velocity.download",
        title: "Download HTML report",
        run() {
          const s = stats();
          if (s) {
            try {
              const projectDir = api.state.path.directory || api.state.path.worktree;
              debugLog(`[velocity] download command: projectDir=${projectDir}`);
               const path = downloadVelocityReport(s, projectDir, creditConfig());
              setDownloadMessage(`Report saved: ${path}`);
              setTimeout(() => setDownloadMessage(null), 3000);
              api.attention.notify({ title: "Report Downloaded", message: path });
            } catch (err) {
              debugLog(`[velocity] download failed: ${err}`);
              setDownloadMessage(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
              setTimeout(() => setDownloadMessage(null), 3000);
              api.attention.notify({ title: "Download Failed", message: err instanceof Error ? err.message : String(err) });
            }
          }
        },
      },
      {
        name: "velocity.configure-credits",
        title: "Configure cost per credit",
        run() {
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Configure cost per credit"
              description={() => <text>Enter dollars per credit. Default: 0.01</text>}
              placeholder="0.01"
              value={creditConfig().dollarsPerCredit.toString()}
              onConfirm={(value) => {
                const dollarsPerCredit = Number(value);
                if (!Number.isFinite(dollarsPerCredit) || dollarsPerCredit <= 0) {
                  api.ui.toast({ variant: "error", message: "Enter a positive dollar amount." });
                  return;
                }
                setCreditConfig({ dollarsPerCredit });
                saveCreditConfig({ dollarsPerCredit });
                api.ui.dialog.clear();
              }}
            />
          ));
        },
      },
      {
        name: "velocity.filter",
        title: "Filter report by date",
        run() { openFilterDialog(); },
      },
    ],
    bindings: [
      { key: "escape,q", cmd: "velocity.close" },
      { key: "backspace", cmd: "velocity.back" },
      { key: "d", cmd: "velocity.download" },
      { key: "f", cmd: "velocity.filter" },
      { key: "c", cmd: "velocity.configure-credits" },
    ],
  } as const;

  // ── Open / close ────────────────────────────────────────────────────────
  const resetState = () => {
    setStats(null);
    setLoadError(null);
    setSelectedProject(null);
    setDateRange(undefined);
  };

  const openDashboard = () => {
    resetState();
    fetchStats();
    const currentRoute = api.route.current;
    returnRoute = "params" in currentRoute
      ? { name: currentRoute.name, params: currentRoute.params }
      : { name: currentRoute.name };
    unregisterNav = api.keymap.registerLayer(NAV_LAYER);
    api.route.navigate(ROUTE);
  };

  const closeDashboard = () => {
    resetState();
    unregisterNav?.();
    unregisterNav = undefined;
    const route = returnRoute;
    returnRoute = { name: "home" };
    setTimeout(() => api.route.navigate(route.name, "params" in route ? route.params : undefined), 0);
  };

  // ── Route ───────────────────────────────────────────────────────────────
  const unregisterRoute = api.route.register([
    {
      name: ROUTE,
      render: () => (
        <VelocityDashboard
          api={api}
          stats={stats()}
          loading={loading()}
           loadError={loadError()}
           dateRange={dateRange()}
          selectedProject={selectedProject()}
          onSelectProject={(id) => setSelectedProject(id)}
          onBack={() => setSelectedProject(null)}
           onDownload={() => {
            const s = stats();
            if (s) {
              try {
                const projectDir = api.state.path.directory || api.state.path.worktree;
                debugLog(`[velocity] onDownload: projectDir=${projectDir}`);
               const path = downloadVelocityReport(s, projectDir, creditConfig());
                setDownloadMessage(`Report saved: ${path}`);
                setTimeout(() => setDownloadMessage(null), 3000);
                api.attention.notify({ title: "Report Downloaded", message: path });
              } catch (err) {
                debugLog(`[velocity] onDownload failed: ${err}`);
                setDownloadMessage(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
                setTimeout(() => setDownloadMessage(null), 3000);
                api.attention.notify({ title: "Download Failed", message: err instanceof Error ? err.message : String(err) });
              }
            }
           }}
            downloadMessage={downloadMessage()}
            onFilter={openFilterDialog}
           creditConfig={creditConfig()}
         />
      ),
    },
  ]);

  // ── /velocity command ───────────────────────────────────────────────────
  const unregisterOpen = api.keymap.registerLayer({
    commands: [
      {
        name: "velocity.open",
        title: "Complete AI performance & cost visibility",
        slashName: "velocity",
        category: "Stats",
        namespace: "palette",
        run() { openDashboard(); },
      },
    ],
  });

  api.lifecycle.onDispose(() => {
    unregisterNav?.();
    unregisterRoute();
    unregisterOpen();
  });
};

// ── Dashboard component ────────────────────────────────────────────────────
interface DashboardProps {
  api: TuiPluginApi;
  stats: OverallStats | null;
  loading: boolean;
  loadError: string | null;
  dateRange?: DateRange;
  selectedProject: string | null;
  onSelectProject: (id: string) => void;
  onBack: () => void;
  onDownload: () => void;
  onFilter: () => void;
  downloadMessage: string | null;
  creditConfig: CreditConfig;
}

function VelocityDashboard(props: DashboardProps) {
  const theme = () => props.api.theme.current;

  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" flexDirection="column">
      {/* Header */}
      <box flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text style={{ fg: props.stats ? theme().accent : theme().textMuted }}>
          {props.selectedProject ? "Project Detail" : `Velocity Report v${VERSION}`}
        </text>
        <box flexGrow={1} />
          <text style={{ fg: theme().textMuted }}>c: configure credits ({fmtCost(props.creditConfig.dollarsPerCredit)}/credit) · f: filter · d: download · Esc: close</text>
      </box>
      <box flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text style={{ fg: theme().textMuted }}>
          Generated: {props.stats ? new Date(props.stats.generatedAt).toLocaleString() : "-"} · Date Range: {formatDateRange(props.dateRange)}
        </text>
      </box>
      <box flexShrink={0} border={["bottom"]} borderColor={theme().border} />

      {/* Content */}
      <Show when={props.loadError}>
        <box paddingLeft={1} paddingTop={1} flexDirection="column">
          <text style={{ fg: theme().error }}>Error: {props.loadError}</text>
          <text style={{ fg: theme().textMuted }}>Press Esc to close</text>
        </box>
      </Show>
      <Show when={props.loading && !props.loadError}>
        <box paddingLeft={1} paddingTop={1}>
          <text style={{ fg: theme().textMuted }}>Loading stats...</text>
        </box>
      </Show>
      <Show when={props.downloadMessage}>
        <box
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          justifyContent="center"
          alignItems="center"
        >
          <text style={{ fg: theme().accent, bg: theme().border }}>
            ✓ {props.downloadMessage}
          </text>
        </box>
      </Show>
      <Show when={!props.loading && !props.loadError && props.stats}>
        {(stats) => (
          <Show
            when={props.selectedProject}
            fallback={<OverviewPanel stats={stats()} theme={theme} onSelectProject={props.onSelectProject} onDownload={props.onDownload} onFilter={props.onFilter} creditConfig={props.creditConfig} />}
          >
            {(projId) => {
              const project = () => stats().projects.find((p) => p.id === projId());
              return (
                <Show when={project()} fallback={<OverviewPanel stats={stats()} theme={theme} onSelectProject={props.onSelectProject} onDownload={props.onDownload} onFilter={props.onFilter} creditConfig={props.creditConfig} />}>
                  {(proj) => (
                    <ProjectDetailPanel
                      project={proj()}
                      theme={theme()}
                      onBack={props.onBack}
                      creditConfig={props.creditConfig}
                    />
                  )}
                </Show>
              );
            }}
          </Show>
        )}
      </Show>

      {/* Footer */}
      <box flexShrink={0} border={["top"]} borderColor={theme().border} paddingLeft={1} paddingRight={1} flexDirection="row">
        <text style={{ fg: theme().textMuted }}>c: configure credits ({fmtCost(props.creditConfig.dollarsPerCredit)}/credit) · f: filter · d: download · Esc: close</text>
      </box>
    </box>
  );
}

// ── Overview panel ─────────────────────────────────────────────────────────
interface OverviewPanelProps {
  stats: OverallStats;
  theme: () => TuiThemeCurrent;
  onSelectProject: (id: string) => void;
  onDownload: () => void;
  onFilter: () => void;
  creditConfig: CreditConfig;
}

function OverviewPanel(props: OverviewPanelProps) {
  const s = props.stats;
  const projectCount = countProjectsWithSessions(s.projects);
  const tc = () => props.theme().text;
  const tm = () => props.theme().textMuted;
  const ta = () => props.theme().accent;
  const tw = () => props.theme().warning;
  const tg = () => props.theme().success;

  return (
    <scrollbox flexGrow={1}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Summary */}
        <box flexDirection="column" marginBottom={1}>
          <text style={{ fg: ta() }}>SUMMARY — all projects</text>
          <text style={{ fg: tc() }}>
             Projects {fmtNumber(projectCount)}  ·  Sessions {fmtNumber(s.sessionCount)}  ·  User Turns{" "}
            {fmtNumber(s.turnCount)}  ·  Messages {fmtNumber(s.messageCount)}
          </text>
          <text style={{ fg: tc() }}>Total tokens: {fmtCompact(totalTokens(s.tokens))}</text>
          <text style={{ fg: tc() }}>
            {"  "}input {fmtCompact(s.tokens.input)}  ·  output {fmtCompact(s.tokens.output)}  ·  reasoning{" "}
            {fmtCompact(s.tokens.reasoning)}
          </text>
          <text style={{ fg: tc() }}>
            {"  "}cache read {fmtCompact(s.tokens.cacheRead)}  ·  cache write {fmtCompact(s.tokens.cacheWrite)}
          </text>
          <text style={{ fg: tg() }}>Total credits: {fmtCredits(s.cost, props.creditConfig)}</text>
          <text style={{ fg: tg() }}>Total spent: {fmtCost(s.cost)}</text>
        </box>

        {/* Averages */}
        <box flexDirection="column" marginBottom={1} flexGrow={1}>
          <text style={{ fg: ta() }}>AVERAGES</text>
          <box flexDirection="row" gap={2} flexGrow={1}>
            {/* Left column */}
            <box flexDirection="column" flexGrow={1}>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tm() }} width={22}>METRIC</text>
                <text style={{ fg: tm() }} width={12}>VALUE</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Tokens / session</text>
                <text style={{ fg: tc() }} width={12}>{fmtCompact(s.averages.tokensPerSession)}</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Credits / session</text>
                <text style={{ fg: tc() }} width={12}>{fmtCredits(s.averages.costPerSession, props.creditConfig)}</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Messages / session</text>
                <text style={{ fg: tc() }} width={12}>{s.averages.messagesPerSession.toFixed(1)}</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Tokens / message</text>
                <text style={{ fg: tc() }} width={12}>{fmtCompact(s.averages.tokensPerMessage)}</text>
              </box>
            </box>
            {/* Right column */}
            <box flexDirection="column" flexGrow={1}>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tm() }} width={22}>METRIC</text>
                <text style={{ fg: tm() }} width={12}>VALUE</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
          <text style={{ fg: tc() }} width={22}>Credits / message</text>
          <text style={{ fg: tc() }} width={12}>{fmtCredits(s.averages.costPerMessage, props.creditConfig)}</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Tokens / project</text>
                <text style={{ fg: tc() }} width={12}>{fmtCompact(s.averageTokensPerProject)}</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Credits / project</text>
                <text style={{ fg: tc() }} width={12}>{fmtCredits(s.averageCostPerProject, props.creditConfig)}</text>
              </box>
              <box flexDirection="row" gap={1} flexGrow={1}>
                <text style={{ fg: tc() }} width={22}>Sessions / project</text>
                <text style={{ fg: tc() }} width={12}>{s.averageSessionsPerProject.toFixed(1)}</text>
              </box>
            </box>
          </box>
        </box>

        {/* Models */}
        <Show when={s.models.size > 0}>
          <box flexDirection="column" marginBottom={1} flexGrow={1}>
            <text style={{ fg: ta() }}>MODELS USED</text>
            <box flexDirection="row" gap={1} flexGrow={1}>
              <text style={{ fg: tm() }} width={30}>MODEL</text>
              <text style={{ fg: tm() }} width={10}>MSGS</text>
              <text style={{ fg: tm() }} width={12}>TOKENS</text>
              <text style={{ fg: tm() }} width={10}>COST</text>
            </box>
            <For each={[...s.models.values()].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))}>
              {(m) => (
                <box flexDirection="row" gap={1} flexGrow={1}>
                  <text style={{ fg: tc() }} width={30}>{m.model}</text>
                  <text style={{ fg: tc() }} width={10}>{m.messages}</text>
                  <text style={{ fg: tc() }} width={12}>{fmtCompact(totalTokens(m.tokens))}</text>
                  <text style={{ fg: tc() }} width={10}>{fmtCost(m.cost)}</text>
                </box>
              )}
            </For>
          </box>
        </Show>

        {/* Tool calls */}
        <box flexDirection="column" marginBottom={1} flexGrow={1}>
          <text style={{ fg: ta() }}>TOOL CALLS</text>
          <Show
            when={s.toolCallsTracked && s.toolCalls.size > 0}
            fallback={<text style={{ fg: tm() }}>No tool-call data found.</text>}
          >
            <For each={[...s.toolCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)}>
              {([tool, calls]) => {
                const max = Math.max(1, ...s.toolCalls.values());
                const barLen = Math.max(1, Math.round((calls / max) * 60));
                const bar = "█".repeat(barLen);
                return (
                  <box flexDirection="row" flexGrow={1}>
                    <text style={{ fg: tc() }} width={25}>
                      {tool}
                    </text>
                    <text style={{ fg: tc() }} flexGrow={1}>
                      {bar} {fmtNumber(calls)}
                    </text>
                  </box>
                );
              }}
            </For>
          </Show>
        </box>

        {/* Projects with sessions as rows */}
        <box flexDirection="column">
          <text style={{ fg: tw() }}>PROJECTS ({projectCount})</text>

          {/* Column header */}
          <box flexDirection="row" marginTop={1} gap={1} paddingLeft={2}>
            <text style={{ fg: tm() }} width={40}>TITLE</text>
            <text style={{ fg: tm() }} width={12}>TOKENS</text>
            <text style={{ fg: tm() }} width={16}>IN / OUT</text>
             <text style={{ fg: tm() }} width={18}>CACHE R/W</text>
            <text style={{ fg: tm() }} width={8}>COST</text>
            <text style={{ fg: tm() }} width={10}>CREDITS</text>
            <text style={{ fg: tm() }} width={8}>EFFORT</text>
            <text style={{ fg: tm() }} width={20}>LAST ACTIVITY</text>
          </box>
          <box border={["bottom"]} borderColor={tm()} />

          <For each={s.projects}>
            {(project: ProjectStats) => {
              const grouped = groupSessions(project.sessions);
              return (
              <box flexDirection="column" marginTop={1}>
                {/* Project name — clickable */}
                <text
                  style={{ fg: ta() }}
                  onMouseDown={() => props.onSelectProject(project.id)}
                >
                  {project.name}
                </text>
                {/* Project path */}
                {project.worktree && (
                  <text style={{ fg: tm() }}>  {project.worktree}</text>
                )}
                {/* Project summary */}
                <text style={{ fg: tc() }}>
                    {"  "}{fmtNumber(project.sessionCount)} sessions · {fmtNumber(project.turnCount)} user turns · {fmtNumber(project.messageCount)} messages · {fmtCompact(totalTokens(project.tokens))} tokens · {fmtCredits(project.cost, props.creditConfig)} credits · spent: {fmtCost(project.cost)} · effort: {fmtEffortHours(project.effortMs)} · last activity: {fmtDate(project.lastActivity)}
                </text>

                {/* Sessions grouped: parent + subagents */}
                <For each={grouped}>
                  {(gs: GroupedSession) => (
                    <box flexDirection="column">
                      <box flexDirection="row" paddingLeft={2} gap={1}>
                        <text style={{ fg: tc() }} width={40}>
                          {gs.parent.title || "(untitled)"}
                        </text>
                        <text style={{ fg: tc() }} width={12}>
                          {fmtCompact(totalTokens(gs.parent.tokens))}
                        </text>
                        <text style={{ fg: tc() }} width={16}>
                          {fmtCompact(gs.parent.tokens.input)} / {fmtCompact(gs.parent.tokens.output)}
                        </text>
                         <text style={{ fg: tc() }} width={18}>
                           {fmtCompact(gs.parent.tokens.cacheRead)} / {fmtCompact(gs.parent.tokens.cacheWrite)}
                        </text>
                        <text style={{ fg: tg() }} width={8}>
                          {fmtCost(gs.parent.cost)}
                        </text>
                        <text style={{ fg: tg() }} width={10}>
                          {fmtCredits(gs.parent.cost, props.creditConfig)}
                        </text>
                        <text style={{ fg: tc() }} width={8}>
                          {fmtEffortMins(gs.parent.durationMs)}
                        </text>
                        <text style={{ fg: tm() }} width={20}>
                          {fmtDate(gs.parent.updatedAt ?? gs.parent.createdAt)}
                        </text>
                      </box>
                      <For each={gs.children}>
                        {(sub: SessionStats) => (
                          <box flexDirection="row" paddingLeft={4} gap={1}>
                            <text style={{ fg: tm() }} width={38}>
                              ↳ {sub.title || "(untitled)"}
                            </text>
                            <text style={{ fg: tm() }} width={12}>
                              {fmtCompact(totalTokens(sub.tokens))}
                            </text>
                            <text style={{ fg: tm() }} width={16}>
                              {fmtCompact(sub.tokens.input)} / {fmtCompact(sub.tokens.output)}
                            </text>
                             <text style={{ fg: tm() }} width={18}>
                               {fmtCompact(sub.tokens.cacheRead)} / {fmtCompact(sub.tokens.cacheWrite)}
                            </text>
                            <text style={{ fg: tm() }} width={8}>
                              {fmtCost(sub.cost)}
                            </text>
                            <text style={{ fg: tm() }} width={10}>
                              {fmtCredits(sub.cost, props.creditConfig)}
                            </text>
                            <text style={{ fg: tm() }} width={8}>
                              {fmtEffortMins(sub.durationMs)}
                            </text>
                            <text style={{ fg: tm() }} width={20}>
                              {fmtDate(sub.updatedAt ?? sub.createdAt)}
                            </text>
                          </box>
                        )}
                      </For>
                    </box>
                  )}
                </For>
              </box>
              );
            }}
          </For>
        </box>
      </box>
    </scrollbox>
  );
}

// ── Project detail panel ───────────────────────────────────────────────────
interface ProjectDetailPanelProps {
  project: ProjectStats;
  theme: TuiThemeCurrent;
  onBack: () => void;
  creditConfig: CreditConfig;
}

function ProjectDetailPanel(props: ProjectDetailPanelProps) {
  const p = props.project;
  const t = () => props.theme;
  const grouped = groupSessions(p.sessions);
  return (
    <scrollbox flexGrow={1}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Back button */}
        <box marginBottom={1}>
          <text style={{ fg: t().accent }} onMouseDown={props.onBack}>
            ← Back to overview
          </text>
        </box>

        {/* Project header */}
        <box flexDirection="column" marginBottom={1} border={true} borderColor={t().accent}>
          <text style={{ fg: t().accent }}>{p.name}</text>
          {p.worktree && (
            <text style={{ fg: t().textMuted }}>{p.worktree}</text>
          )}
           <text style={{ fg: t().text }}>
             {fmtNumber(p.sessionCount)} sessions · {fmtNumber(p.turnCount)} User Turns ·{" "}
             {fmtNumber(p.messageCount)} messages · {fmtCompact(totalTokens(p.tokens))} tokens ·{" "}
              {fmtCredits(p.cost, props.creditConfig)} credits · spent: {fmtCost(p.cost)} · effort: {fmtEffortHours(p.effortMs)}
           </text>
          <text style={{ fg: t().text }}>Last activity: {fmtDate(p.lastActivity)}</text>
        </box>

        {/* Column header */}
        <box flexDirection="row" gap={1}>
          <text style={{ fg: t().textMuted }} width={40}>TITLE</text>
          <text style={{ fg: t().textMuted }} width={12}>TOKENS</text>
          <text style={{ fg: t().textMuted }} width={16}>IN / OUT</text>
          <text style={{ fg: t().textMuted }} width={10}>REASON</text>
          <text style={{ fg: t().textMuted }} width={18}>CACHE R/W</text>
          <text style={{ fg: t().textMuted }} width={8}>COST</text>
          <text style={{ fg: t().textMuted }} width={10}>CREDITS</text>
          <text style={{ fg: t().textMuted }} width={8}>EFFORT</text>
          <text style={{ fg: t().textMuted }} width={20}>LAST ACTIVITY</text>
        </box>
        <box border={["bottom"]} borderColor={t().textMuted} />

        {/* Sessions grouped: parent + subagents */}
        <For each={grouped}>
          {(gs: GroupedSession) => (
            <box flexDirection="column">
              <box flexDirection="row" paddingLeft={0} gap={1}>
                <text style={{ fg: t().text }} width={40}>
                  {gs.parent.title || "(untitled)"}
                </text>
                <text style={{ fg: t().text }} width={12}>
                  {fmtCompact(totalTokens(gs.parent.tokens))}
                </text>
                <text style={{ fg: t().text }} width={16}>
                  {fmtCompact(gs.parent.tokens.input)} / {fmtCompact(gs.parent.tokens.output)}
                </text>
                <text style={{ fg: t().text }} width={10}>
                  {fmtCompact(gs.parent.tokens.reasoning)}
                </text>
                <text style={{ fg: t().text }} width={18}>
                  {fmtCompact(gs.parent.tokens.cacheRead)} / {fmtCompact(gs.parent.tokens.cacheWrite)}
                </text>
                <text style={{ fg: t().success }} width={8}>
                  {fmtCost(gs.parent.cost)}
                </text>
                <text style={{ fg: t().success }} width={10}>
                  {fmtCredits(gs.parent.cost, props.creditConfig)}
                </text>
                <text style={{ fg: t().text }} width={8}>
                  {fmtEffortMins(gs.parent.durationMs)}
                </text>
                <text style={{ fg: t().textMuted }} width={20}>
                  {fmtDate(gs.parent.updatedAt ?? gs.parent.createdAt)}
                </text>
              </box>
              <For each={gs.children}>
                {(sub: SessionStats) => (
                  <box flexDirection="row" paddingLeft={2} gap={1}>
                    <text style={{ fg: t().textMuted }} width={38}>
                      ↳ {sub.title || "(untitled)"}
                    </text>
                    <text style={{ fg: t().textMuted }} width={12}>
                      {fmtCompact(totalTokens(sub.tokens))}
                    </text>
                    <text style={{ fg: t().textMuted }} width={16}>
                      {fmtCompact(sub.tokens.input)} / {fmtCompact(sub.tokens.output)}
                    </text>
                    <text style={{ fg: t().textMuted }} width={10}>
                      {fmtCompact(sub.tokens.reasoning)}
                    </text>
                  <text style={{ fg: t().textMuted }} width={18}>
                    {fmtCompact(sub.tokens.cacheRead)} / {fmtCompact(sub.tokens.cacheWrite)}
                    </text>
                    <text style={{ fg: t().textMuted }} width={8}>
                      {fmtCost(sub.cost)}
                    </text>
                    <text style={{ fg: t().textMuted }} width={10}>
                      {fmtCredits(sub.cost, props.creditConfig)}
                    </text>
                    <text style={{ fg: t().textMuted }} width={8}>
                      {fmtEffortMins(sub.durationMs)}
                    </text>
                    <text style={{ fg: t().textMuted }} width={20}>
                      {fmtDate(sub.updatedAt ?? sub.createdAt)}
                    </text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
    </scrollbox>
  );
}

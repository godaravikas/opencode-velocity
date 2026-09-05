// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  creditsFromCost,
  loadCreditConfig,
  saveCreditConfig,
  DEFAULT_CREDIT_CONFIG,
} from "../src/credits.ts";
import { renderHtmlReport } from "../src/html-report.ts";
import { countProjectsWithSessions, formatReportTimestamp } from "../src/tui.tsx";
import type { OverallStats } from "../src/types.ts";
import { emptyTokenTotals, emptyAverages } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 1. Credit conversion tests
// ---------------------------------------------------------------------------

describe("creditsFromCost", () => {
  test("0.10 at $0.01/credit → 10", () => {
    expect(creditsFromCost(0.10, { dollarsPerCredit: 0.01 })).toBe(10);
  });

  test("0.10 at $0.02/credit → 5", () => {
    expect(creditsFromCost(0.10, { dollarsPerCredit: 0.02 })).toBe(5);
  });

  test("0 with DEFAULT_CREDIT_CONFIG → 0", () => {
    expect(creditsFromCost(0, DEFAULT_CREDIT_CONFIG)).toBe(0);
  });

  test("0.015 with DEFAULT_CREDIT_CONFIG → 2 (rounds to nearest)", () => {
    // 0.015 / 0.01 = 1.5, rounds to 2
    expect(creditsFromCost(0.015, DEFAULT_CREDIT_CONFIG)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Persistent config tests
// ---------------------------------------------------------------------------

describe("loadCreditConfig / saveCreditConfig", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "velocity-test-"));
    originalEnv = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns DEFAULT_CREDIT_CONFIG when no file exists", () => {
    const config = loadCreditConfig();
    expect(config).toEqual(DEFAULT_CREDIT_CONFIG);
  });

  test("round-trips a saved config", () => {
    saveCreditConfig({ dollarsPerCredit: 0.05 });
    const config = loadCreditConfig();
    expect(config).toEqual({ dollarsPerCredit: 0.05 });
  });

  test("falls back to DEFAULT_CREDIT_CONFIG on malformed JSON", () => {
    writeFileSync(join(tmpDir, "velocity-credits.json"), "{ not valid json }", "utf8");
    const config = loadCreditConfig();
    expect(config).toEqual(DEFAULT_CREDIT_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// 3. HTML report label tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport", () => {
  const minimalStats: OverallStats = {
    dataDir: "",
    generatedAt: 0,
    projectCount: 1,
    sessionCount: 0,
    subagentCount: 0,
    messageCount: 0,
    turnCount: 0,
    tokens: emptyTokenTotals(),
    cost: 0,
    averages: emptyAverages(),
    averageTokensPerProject: 0,
    averageCostPerProject: 0,
    averageSessionsPerProject: 0,
    projects: [
      {
        id: "proj-1",
        name: "test-project",
        sessions: [],
        sessionCount: 0,
        subagentCount: 0,
        messageCount: 0,
        turnCount: 0,
        tokens: emptyTokenTotals(),
        cost: 0,
        averages: emptyAverages(),
        effortMs: 0,
        models: new Map(),
        toolCalls: new Map(),
      },
    ],
    mostActiveProject: undefined,
    models: new Map(),
    toolCalls: new Map(),
    toolCallsTracked: false,
  };

  test('contains "Effort" label in per-project summary', () => {
    const html = renderHtmlReport(minimalStats, { dollarsPerCredit: 0.02 });
    expect(html).toContain("Effort");
  });

  test('contains "$0.02" (credit rate) in footer', () => {
    const html = renderHtmlReport(minimalStats, { dollarsPerCredit: 0.02 });
    expect(html).toContain("$0.02");
  });

  test('does NOT contain "Session ID" as a table header', () => {
    const html = renderHtmlReport(minimalStats, { dollarsPerCredit: 0.02 });
    // The session table uses "Session" not "Session ID"
    expect(html).not.toContain("<th>Session ID</th>");
  });
});

describe("downloadVelocityReport", () => {
  test("uses a local datetime in the report filename", () => {
    expect(formatReportTimestamp(new Date(2026, 8, 2, 14, 5, 9))).toBe("2026-09-02_14-05-09");
  });
});

describe("countProjectsWithSessions", () => {
  test("excludes projects with no sessions from the TUI count", () => {
    const projects = [
      { id: "empty", name: "empty", sessions: [] },
      { id: "active", name: "active", sessions: [{ id: "session-1" }] },
    ] as OverallStats["projects"];

    expect(countProjectsWithSessions(projects)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Smoke test — DEFAULT_CREDIT_CONFIG sanity check
// ---------------------------------------------------------------------------

describe("DEFAULT_CREDIT_CONFIG", () => {
  test("dollarsPerCredit === 0.01", () => {
    expect(DEFAULT_CREDIT_CONFIG.dollarsPerCredit).toBe(0.01);
  });
});

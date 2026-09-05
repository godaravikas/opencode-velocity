// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";
import { aggregate } from "./aggregate.ts";
import { resolveDataDirs } from "./storage.ts";
import type { NormalizedData, NormalizedMessage, NormalizedProject, NormalizedSession, OverallStats, TokenTotals } from "./types.ts";
import { emptyTokenTotals } from "./types.ts";

function debugLog(msg: string) {
  try {
    const dir = join(process.env.HOME ?? "~", ".local", "share", "opencode", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "velocity-debug.log"), msg + "\n", { flag: "a" });
  } catch {}
}

/**
 * Read session/project/message data directly from the opencode SQLite database.
 *
 * Sessions are grouped by `session.directory` (not `project_id`, since the
 * project table is just a single "global" row). This gives us real paths.
 */
export function resolveDatabasePath(dataDir?: string): string {
  const candidates = resolveDataDirs(dataDir).flatMap((dir) => {
    const rootDatabase = join(dir, "opencode.db");
    // TUI state.path.state points to OpenCode's `storage` directory, while
    // the SQLite database is stored one level above it.
    const paths = basename(dir) === "storage"
      ? [join(dirname(dir), "opencode.db"), rootDatabase]
      : [rootDatabase];
    const normalized = normalize(dir);
    const stateMarker = `${sep}state${sep}`;
    if (normalized.includes(stateMarker)) {
      paths.push(join(normalized.replace(stateMarker, `${sep}share${sep}`), "opencode.db"));
    }
    return paths;
  });
  const existing = candidates.find((path) => existsSync(path));
  if (existing) return existing;
  throw new Error(`Could not find the OpenCode SQLite database. Checked: ${candidates.join(", ")}`);
}

export async function buildStatsFromDb(dataDir?: string): Promise<OverallStats> {
  const dbPath = resolveDatabasePath(dataDir);
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true, create: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to open the read-only OpenCode database at ${dbPath}: ${detail}`);
  }

  try {
    // ── Sessions ──────────────────────────────────────────────────────────
    const rawSessions = db.query(`
      SELECT id, project_id, title, directory, parent_id, cost,
             tokens_input, tokens_output, tokens_reasoning,
             tokens_cache_read, tokens_cache_write,
             model, time_created, time_updated
      FROM session
      ORDER BY time_updated DESC
    `).all() as Array<{
      id: string; project_id: string; title: string; directory: string;
      parent_id?: string; cost: number;
      tokens_input: number; tokens_output: number; tokens_reasoning: number;
      tokens_cache_read: number; tokens_cache_write: number;
      model?: string; time_created: number; time_updated: number;
    }>;
    debugLog(`[velocity] DB: ${rawSessions.length} sessions`);

    // ── Tool calls (from part table) ──────────────────────────────────────
    const toolCallBySession = db.query(`
      SELECT s.id as session_id, p.data
      FROM part p
      JOIN session s ON p.session_id = s.id
    `).all() as Array<{ session_id: string; data: string }>;

    const sessionToolCalls = new Map<string, string[]>();
    let anyParts = false;
    for (const row of toolCallBySession) {
      try {
        const part = JSON.parse(row.data);
        if (part.type === "tool" && part.tool) {
          anyParts = true;
          const existing = sessionToolCalls.get(row.session_id);
          if (existing) {
            existing.push(part.tool);
          } else {
            sessionToolCalls.set(row.session_id, [part.tool]);
          }
        }
      } catch {}
    }
    debugLog(`[velocity] DB: ${sessionToolCalls.size} sessions with tool calls`);

    // ── Messages (for model info per assistant message) ────────────────────
    const messageRows = db.query(`
      SELECT session_id, time_created, data FROM message ORDER BY session_id, time_created
    `).all() as Array<{ session_id: string; time_created: number; data: string }>;

    const messagesBySession = new Map<string, Array<{ role?: string; modelID?: string; providerID?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }; _time_created?: number; _time_completed?: number }>>();
    for (const row of messageRows) {
      try {
        const msg = JSON.parse(row.data);
        // Attach the DB-level timestamp (more reliable than the JSON blob field)
        msg._time_created = row.time_created ?? msg.time?.created;
        msg._time_completed = msg.time?.completed;
        const existing = messagesBySession.get(row.session_id);
        if (existing) {
          existing.push(msg);
        } else {
          messagesBySession.set(row.session_id, [msg]);
        }
      } catch {}
    }

    // ── Group sessions by directory (the real project path) ────────────────
    const projectsByDir = new Map<string, NormalizedProject>();

    // First pass: collect all sessions by their directory
    const sessionsByDir = new Map<string, NormalizedSession[]>();
    for (const rawSession of rawSessions) {
      const dir = rawSession.directory;
      if (!sessionsByDir.has(dir)) {
        sessionsByDir.set(dir, []);
      }

      const tokens: TokenTotals = {
        input: rawSession.tokens_input ?? 0,
        output: rawSession.tokens_output ?? 0,
        reasoning: rawSession.tokens_reasoning ?? 0,
        cacheRead: rawSession.tokens_cache_read ?? 0,
        cacheWrite: rawSession.tokens_cache_write ?? 0,
      };
      const cost = rawSession.cost ?? 0;
      const tools = sessionToolCalls.get(rawSession.id) ?? [];

      let modelID: string | undefined;
      let providerID: string | undefined;
      if (rawSession.model) {
        try {
          const m = JSON.parse(rawSession.model);
          modelID = m.id;
          providerID = m.providerID;
        } catch {
          modelID = rawSession.model;
        }
      }

      const sessionMsgs = messagesBySession.get(rawSession.id) ?? [];
      const normMessages: NormalizedMessage[] = [];

       if (sessionMsgs.length > 0) {
        for (const msg of sessionMsgs) {
          if (msg.role === "user") {
            normMessages.push({ role: "user", cost: 0, tokens: emptyTokenTotals(), toolCalls: [], createdAt: msg._time_created });
            continue;
          }
           if (msg.role !== "assistant") continue;
          const msgTokens = msg.tokens
            ? {
                input: msg.tokens.input ?? 0,
                output: msg.tokens.output ?? 0,
                reasoning: msg.tokens.reasoning ?? 0,
                cacheRead: msg.tokens.cache?.read ?? 0,
                cacheWrite: msg.tokens.cache?.write ?? 0,
              }
            : emptyTokenTotals();
          normMessages.push({
            role: "assistant",
            modelID: msg.modelID,
            providerID: msg.providerID,
            cost: msg.cost ?? 0,
            tokens: msgTokens,
             toolCalls: [],
            createdAt: msg._time_created,
            completedAt: msg._time_completed,
          });
        }
      }

      if (normMessages.length === 0 && (cost > 0 || sumTokens(tokens) > 0 || modelID)) {
        normMessages.push({
          role: "assistant",
          modelID,
          providerID,
          cost,
          tokens,
          toolCalls: tools,
        });
      } else if (normMessages.length > 0) {
        const lastAssistant = [...normMessages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant && tools.length > 0) {
          lastAssistant.toolCalls = tools;
        }
      }

      const session: NormalizedSession = {
        id: rawSession.id,
        title: rawSession.title ?? "",
        directory: rawSession.directory,
        isSubagent: Boolean(rawSession.parent_id),
        parentID: rawSession.parent_id ?? undefined,
        createdAt: rawSession.time_created,
        updatedAt: rawSession.time_updated,
        durationMs: computeDurationMs(normMessages),
        messages: normMessages,
      };

      sessionsByDir.get(dir)!.push(session);
    }

    // Second pass: validate parent_id references within each project
    // Sessions should only be children of sessions in the same project
    for (const [dir, sessions] of sessionsByDir) {
      const sessionIds = new Set(sessions.map(s => s.id));
      for (const session of sessions) {
        if (session.parentID && !sessionIds.has(session.parentID)) {
          // Parent doesn't exist in this project - treat as top-level session
          session.parentID = undefined;
          session.isSubagent = false;
        }
      }
    }

    // Third pass: create projects and assign sessions
    for (const [dir, sessions] of sessionsByDir) {
      const segments = dir.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
      const dirName = segments.length > 0 ? segments[segments.length - 1] : dir;
      const proj: NormalizedProject = {
        id: dir,
        name: dirName,
        worktree: dir,
        sessions,
      };
      projectsByDir.set(dir, proj);
    }

    // Sort projects by most recent session
    const projects = [...projectsByDir.values()].sort((a, b) => {
      const aMax = Math.max(...a.sessions.map((s) => s.updatedAt ?? 0), 0);
      const bMax = Math.max(...b.sessions.map((s) => s.updatedAt ?? 0), 0);
      return bMax - aMax;
    });

    const data: NormalizedData = {
      source: dbPath,
      toolCallsAvailable: anyParts,
      projects,
    };

    const totalSessions = data.projects.reduce((a, p) => a + p.sessions.length, 0);
    debugLog(`[velocity] DB done: ${data.projects.length} projects, ${totalSessions} total sessions`);

    return aggregate(data);
  } finally {
    db.close();
  }
}

function sumTokens(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

/**
 * Compute active effort in ms from a list of normalized messages.
 *
 * Strategy: for each user→assistant pair, measure the gap between the user
 * message createdAt and the assistant message completedAt (or createdAt as
 * fallback). Gaps over 30 min are capped to exclude idle time between sessions
 * being resumed. Returns undefined if no timestamps are available.
 */
function computeDurationMs(messages: NormalizedMessage[]): number | undefined {
  const MAX_TURN_MS = 30 * 60 * 1000; // 30-minute cap per turn
  let total = 0;
  let hasAny = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || msg.createdAt === undefined) continue;

    // Collect all consecutive assistant messages before the next user message.
    // The turn spans the full agent loop (tool calls + final reply), so we
    // measure to the LAST assistant message in the sequence, not the first.
    let lastEnd: number | undefined;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "user") break;
      if (messages[j].role !== "assistant") continue;
      const end = messages[j].completedAt ?? messages[j].createdAt;
      if (end !== undefined) lastEnd = end;
    }

    if (lastEnd === undefined) continue;
    const gap = lastEnd - msg.createdAt;
    if (gap > 0) {
      total += Math.min(gap, MAX_TURN_MS);
      hasAny = true;
    }
  }

  return hasAny ? total : undefined;
}

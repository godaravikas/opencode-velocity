// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { basename } from "node:path";
import { aggregate } from "./aggregate.ts";
import {
  discoverStorage,
  loadMessagesForSession,
  loadPartsForMessage,
  loadProjects,
  loadSessions,
  resolveDataDirs,
  type DiscoveredStorage,
} from "./storage.ts";
import type { NormalizedData, NormalizedProject, NormalizedSession, OverallStats, RawMessageFile, TokenTotals } from "./types.ts";
import { emptyTokenTotals } from "./types.ts";

export interface BuildStatsOptions {
  /** Explicit OPENCODE_DATA_DIR override (comma-separated for multiple roots). */
  dataDir?: string;
  /** Only include sessions active on/after this epoch-ms timestamp. */
  since?: number;
  /** Only include sessions active on/before this epoch-ms timestamp. */
  until?: number;
}

function tokensFromMessage(msg: RawMessageFile): TokenTotals {
  const t = msg.tokens;
  if (!t) return emptyTokenTotals();
  return {
    input: t.input ?? 0,
    output: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0,
  };
}

/** True for part types that represent an actual tool invocation. */
function isToolCallPart(type: string | undefined): boolean {
  return type === "tool" || type === "tool_use" || type === "tool-invocation" || type === "tool_call";
}

function projectDisplayName(id: string, worktree?: string): string {
  if (worktree && worktree.trim().length > 0) {
    return basename(worktree.replace(/[\\/]+$/, "")) || worktree;
  }
  return id.length > 12 ? `project-${id.slice(0, 8)}` : id;
}

/**
 * Reads opencode's on-disk JSON storage tree (storage/project, storage/session,
 * storage/message, storage/part) and builds NormalizedData for aggregate().
 *
 * IMPORTANT: as of mid/late-2026 opencode builds, session/message data may
 * live in a SQLite database instead of (or in addition to) this flat JSON
 * tree — see src/sdk-source.ts, which reads through the opencode SDK/HTTP
 * API instead and is what the live plugin (project-stats.tui.tsx /
 * project-stats.ts) prefers when a client is available. This file-based
 * reader exists so the CLI and `bun test` keep working with zero opencode
 * server running, using the mock data from scripts/generate-mock-data.ts.
 * If this returns zero projects against your real ~/.local/share/opencode,
 * that's expected on those builds — use the plugin (SDK-based) instead, or
 * point --data-dir at wherever your version actually keeps the JSON tree.
 */
export function buildStatsFromStorage(options: BuildStatsOptions = {}): OverallStats {
  const dirs = resolveDataDirs(options.dataDir);
  let storage: DiscoveredStorage | undefined;
  for (const d of dirs) {
    const candidate = discoverStorage(d);
    if (candidate.exists) {
      storage = candidate;
      break;
    }
  }
  if (!storage) storage = discoverStorage(dirs[0]);

  const rawProjects = loadProjects(storage);
  const rawSessions = loadSessions(storage);

  const projectsById = new Map<string, NormalizedProject>();
  let anyPartFileSeen = false;

  const getProject = (id: string): NormalizedProject => {
    let p = projectsById.get(id);
    if (!p) {
      const meta = rawProjects.get(id);
      p = {
        id,
        name: projectDisplayName(id, meta?.worktree),
        worktree: meta?.worktree,
        vcs: meta?.vcs,
        sessions: [],
      };
      projectsById.set(id, p);
    }
    return p;
  };

  for (const { projectId, raw } of rawSessions) {
    const createdAt = raw.time?.created;
    const updatedAt = raw.time?.updated;
    const activityTime = updatedAt ?? createdAt;
    if (options.since !== undefined && activityTime !== undefined && activityTime < options.since) continue;
    if (options.until !== undefined && activityTime !== undefined && activityTime > options.until) continue;

    const messages = loadMessagesForSession(storage, raw.id);
    const normSession: NormalizedSession = {
      id: raw.id,
      title: raw.title ?? "",
      directory: raw.directory,
      isSubagent: Boolean(raw.parentID),
      createdAt,
      updatedAt,
      messages: [],
    };

    for (const msg of messages) {
      const toolNames: string[] = [];
      if (msg.role === "assistant") {
        const parts = loadPartsForMessage(storage, msg.id);
        if (parts.length > 0) anyPartFileSeen = true;
        for (const part of parts) {
          if (isToolCallPart(part.type)) toolNames.push(part.tool || "unknown");
        }
      }
      normSession.messages.push({
        role: msg.role ?? "unknown",
        modelID: msg.modelID,
        providerID: msg.providerID,
        cost: msg.cost ?? 0,
        tokens: tokensFromMessage(msg),
        toolCalls: toolNames,
      });
    }

    getProject(projectId).sessions.push(normSession);
  }

  const data: NormalizedData = {
    source: storage.dataDir,
    toolCallsAvailable: anyPartFileSeen,
    projects: [...projectsById.values()],
  };

  return aggregate(data);
}

// Backwards-compatible alias used elsewhere in this repo / by the CLI.
export const buildStats = buildStatsFromStorage;

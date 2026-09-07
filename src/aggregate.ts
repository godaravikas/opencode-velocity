// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { basename } from "node:path";
import {
  addTokenTotals,
  emptyAverages,
  emptyTokenTotals,
  mergeToolCalls,
  type Averages,
  type DateRange,
  type ModelUsage,
  type NormalizedData,
  type NormalizedProject,
  type OverallStats,
  type ProjectStats,
  type SessionStats,
  type TokenTotals,
} from "./types.ts";

function recordModelUsage(map: Map<string, ModelUsage>, model: string, tokens: TokenTotals, cost: number) {
  const key = model || "unknown/unknown";
  const existing = map.get(key);
  if (existing) {
    existing.messages += 1;
    existing.tokens = addTokenTotals(existing.tokens, tokens);
    existing.cost += cost;
  } else {
    map.set(key, { model: key, messages: 1, tokens, cost });
  }
}

function projectDisplayName(id: string, worktree?: string): string {
  if (worktree && worktree.trim().length > 0) {
    return basename(worktree.replace(/[\\/]+$/, "")) || worktree;
  }
  return id.length > 12 ? `project-${id.slice(0, 8)}` : id;
}

function computeAverages(tokens: TokenTotals, cost: number, sessionCount: number, messageCount: number): Averages {
  const tokenSum = sumAllTokens(tokens);
  return {
    tokensPerSession: sessionCount > 0 ? tokenSum / sessionCount : 0,
    costPerSession: sessionCount > 0 ? cost / sessionCount : 0,
    messagesPerSession: sessionCount > 0 ? messageCount / sessionCount : 0,
    tokensPerMessage: messageCount > 0 ? tokenSum / messageCount : 0,
    costPerMessage: messageCount > 0 ? cost / messageCount : 0,
  };
}

function sumAllTokens(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

/** Turns NormalizedData (from any source) into the full OverallStats tree. */
export function aggregate(data: NormalizedData, dateRange?: DateRange): OverallStats {
  const projects: ProjectStats[] = [];
  let overallTokens = emptyTokenTotals();
  let overallCost = 0;
  let overallMessageCount = 0;
  let overallTurnCount = 0;
  let overallSessionCount = 0;
  let overallSubagentCount = 0;
  const overallModels = new Map<string, ModelUsage>();
  const overallToolCalls = new Map<string, number>();

  for (const np of data.projects as NormalizedProject[]) {
    const project: ProjectStats = {
      id: np.id,
      name: np.name && np.name.trim().length > 0 ? np.name : projectDisplayName(np.id, np.worktree),
      worktree: np.worktree,
      vcs: np.vcs,
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
    };

    for (const ns of np.sessions) {
      let sessionTokens = emptyTokenTotals();
      let sessionCost = 0;
      let assistantCount = 0;
      let turnCount = 0;
      const sessionModels = new Map<string, ModelUsage>();
      const sessionToolCalls = new Map<string, number>();

      for (const msg of ns.messages) {
        if (msg.role === "user") {
          turnCount += 1;
          continue;
        }
        if (msg.role !== "assistant") continue;

        assistantCount += 1;
        sessionTokens = addTokenTotals(sessionTokens, msg.tokens);
        sessionCost += msg.cost;
        const modelKey = msg.providerID ? `${msg.providerID}/${msg.modelID ?? "unknown"}` : msg.modelID ?? "unknown";
        recordModelUsage(sessionModels, modelKey, msg.tokens, msg.cost);
        recordModelUsage(overallModels, modelKey, msg.tokens, msg.cost);

        for (const tool of msg.toolCalls) {
          sessionToolCalls.set(tool, (sessionToolCalls.get(tool) ?? 0) + 1);
        }
      }

      const session: SessionStats = {
        id: ns.id,
        projectId: np.id,
        title: ns.title && ns.title.trim().length > 0 ? ns.title : `(untitled session ${ns.id.slice(0, 8)})`,
        directory: ns.directory,
        isSubagent: ns.isSubagent,
        parentID: ns.parentID,
        createdAt: ns.createdAt,
        updatedAt: ns.updatedAt,
        durationMs: ns.durationMs,
        messageCount: ns.messages.length,
        assistantMessageCount: assistantCount,
        turnCount,
        tokens: sessionTokens,
        cost: sessionCost,
        models: sessionModels,
        toolCalls: sessionToolCalls,
      };

      project.sessions.push(session);
      if (ns.isSubagent) {
        project.subagentCount += 1;
      } else {
        project.sessionCount += 1;
      }
      project.messageCount += ns.messages.length;
       if (!ns.isSubagent) project.turnCount += turnCount;
      project.tokens = addTokenTotals(project.tokens, sessionTokens);
      project.cost += sessionCost;
      project.effortMs += ns.durationMs ?? 0;
      mergeToolCalls(project.toolCalls, sessionToolCalls);

      const activityTime = ns.updatedAt ?? ns.createdAt;
      if (ns.createdAt !== undefined) {
        project.firstActivity =
          project.firstActivity === undefined ? ns.createdAt : Math.min(project.firstActivity, ns.createdAt);
      }
      if (activityTime !== undefined) {
        project.lastActivity =
          project.lastActivity === undefined ? activityTime : Math.max(project.lastActivity, activityTime);
      }

      overallTokens = addTokenTotals(overallTokens, sessionTokens);
      overallCost += sessionCost;
      overallMessageCount += ns.messages.length;
       if (!ns.isSubagent) overallTurnCount += turnCount;
      if (ns.isSubagent) {
        overallSubagentCount += 1;
      } else {
        overallSessionCount += 1;
      }
      mergeToolCalls(overallToolCalls, sessionToolCalls);
    }

    // Roll up per-model usage for the project from its sessions' own buckets.
    const fixedModels = new Map<string, ModelUsage>();
    for (const session of project.sessions) {
      for (const [key, usage] of session.models) {
        const existing = fixedModels.get(key);
        if (existing) {
          existing.messages += usage.messages;
          existing.tokens = addTokenTotals(existing.tokens, usage.tokens);
          existing.cost += usage.cost;
        } else {
          fixedModels.set(key, { model: key, messages: usage.messages, tokens: usage.tokens, cost: usage.cost });
        }
      }
    }
    project.models = fixedModels;
    project.sessions.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    project.averages = computeAverages(project.tokens, project.cost, project.sessionCount, project.messageCount);

    projects.push(project);
  }

  const projectList = projects.sort((a, b) => {
    const at = sumAllTokens(a.tokens);
    const bt = sumAllTokens(b.tokens);
    if (bt !== at) return bt - at;
    return b.sessionCount - a.sessionCount;
  });

  const overallAverages = computeAverages(overallTokens, overallCost, overallSessionCount, overallMessageCount);
  const projectCount = projectList.length;

  return {
    dataDir: data.source,
    generatedAt: Date.now(),
    dateRange,
    projectCount,
    sessionCount: overallSessionCount,
    subagentCount: overallSubagentCount,
    messageCount: overallMessageCount,
    turnCount: overallTurnCount,
    tokens: overallTokens,
    cost: overallCost,
    averages: overallAverages,
    averageTokensPerProject: projectCount > 0 ? sumAllTokens(overallTokens) / projectCount : 0,
    averageCostPerProject: projectCount > 0 ? overallCost / projectCount : 0,
    averageSessionsPerProject: projectCount > 0 ? overallSessionCount / projectCount : 0,
    projects: projectList,
    mostActiveProject: projectList[0],
    models: overallModels,
    toolCalls: overallToolCalls,
    toolCallsTracked: data.toolCallsAvailable,
  };
}

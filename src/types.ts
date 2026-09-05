// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
/**
 * Type definitions for the slice of opencode's local storage schema that
 * this tool reads. These mirror the shapes documented by the opencode Go/TS
 * SDKs (Project, Session, AssistantMessage, AssistantMessageTokens) as of
 * opencode 1.x. Every field we depend on is read defensively (see
 * src/storage.ts) so a minor schema drift in a newer/older opencode version
 * degrades gracefully instead of crashing.
 */

export interface RawProjectFile {
  id: string;
  worktree?: string;
  vcs?: string;
  time?: {
    created?: number;
    initialized?: number;
  };
  [key: string]: unknown;
}

export interface RawSessionFile {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  version?: string;
  parentID?: string; // present on subagent/child sessions
  time?: {
    created?: number;
    updated?: number;
  };
  [key: string]: unknown;
}

export interface RawTokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

export interface RawMessageFile {
  id: string;
  role?: "user" | "assistant" | string;
  sessionID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  cost?: number;
  tokens?: RawTokenUsage;
  time?: {
    created?: number;
    completed?: number;
  };
  [key: string]: unknown;
}

/**
 * A "part" is opencode's granular unit inside a message (text, reasoning,
 * tool call, step markers, etc.), stored separately under
 * storage/part/{messageId}/*.json. Tool-call parts carry a `tool` field
 * (e.g. "bash", "read", "write", "grep", "webfetch", "websearch", "task")
 * and a `state.status`. NOTE: on some opencode installs/versions this
 * directory can be empty even when tool calls happened (tool results may
 * live under storage/tool-output/ instead) — treat tool-call stats here as
 * best-effort, not guaranteed complete. See src/storage.ts#loadPartsForMessage.
 */
export interface RawPartFile {
  id: string;
  messageID?: string;
  sessionID?: string;
  type?: string; // "tool", "tool_use", "text", "reasoning", "step-start", "step-finish", ...
  tool?: string; // tool name, present on tool-call parts
  callID?: string;
  state?: {
    status?: string;
    time?: { start?: number; end?: number };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Aggregated token counts, always present with numeric (possibly zero) fields. */
export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyTokenTotals(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function sumTokenTotals(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

export interface ModelUsage {
  model: string; // "provider/model"
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

export interface ToolCallUsage {
  tool: string;
  calls: number;
}

export function mapToToolCallUsage(m: Map<string, number>): ToolCallUsage[] {
  return [...m.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls);
}

export function sumToolCalls(m: Map<string, number>): number {
  let total = 0;
  for (const v of m.values()) total += v;
  return total;
}

export function mergeToolCalls(into: Map<string, number>, from: Map<string, number>) {
  for (const [tool, calls] of from) {
    into.set(tool, (into.get(tool) ?? 0) + calls);
  }
}

export interface SessionStats {
  id: string;
  projectId: string;
  title: string;
  directory?: string;
  isSubagent: boolean;
  parentID?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Active effort in milliseconds (sum of per-turn durations). */
  durationMs?: number;
  messageCount: number;
  assistantMessageCount: number;
  turnCount: number; // number of user messages == number of conversational turns
  tokens: TokenTotals;
  cost: number;
  models: Map<string, ModelUsage>;
  toolCalls: Map<string, number>; // tool name -> call count (best-effort, see RawPartFile)
}

export interface Averages {
  tokensPerSession: number;
  costPerSession: number;
  messagesPerSession: number;
  tokensPerMessage: number;
  costPerMessage: number;
}

export function emptyAverages(): Averages {
  return { tokensPerSession: 0, costPerSession: 0, messagesPerSession: 0, tokensPerMessage: 0, costPerMessage: 0 };
}

export interface ProjectStats {
  id: string;
  name: string;
  worktree?: string;
  vcs?: string;
  sessions: SessionStats[];
  /** Number of top-level (non-subagent) sessions. */
  sessionCount: number;
  /** Number of subagent sessions nested under a parent. */
  subagentCount: number;
  messageCount: number;
  turnCount: number;
  tokens: TokenTotals;
  cost: number;
  averages: Averages;
  firstActivity?: number;
  lastActivity?: number;
  /** Total active effort across all sessions in milliseconds. */
  effortMs: number;
  models: Map<string, ModelUsage>;
  toolCalls: Map<string, number>;
}

export interface OverallStats {
  dataDir: string;
  generatedAt: number;
  projectCount: number;
  /** Number of top-level (non-subagent) sessions across all projects. */
  sessionCount: number;
  /** Number of subagent sessions across all projects. */
  subagentCount: number;
  messageCount: number;
  turnCount: number;
  tokens: TokenTotals;
  cost: number;
  averages: Averages;
  averageTokensPerProject: number;
  averageCostPerProject: number;
  averageSessionsPerProject: number;
  projects: ProjectStats[];
  mostActiveProject?: ProjectStats;
  models: Map<string, ModelUsage>;
  toolCalls: Map<string, number>;
  toolCallsTracked: boolean; // false if no part files were found anywhere (see note on RawPartFile)
}

/**
 * Data-source-agnostic normalized shape. Both the raw-file reader
 * (src/storage.ts + src/engine.ts, used by the CLI so it works without a
 * running opencode server) and the SDK-client reader (src/sdk-source.ts,
 * used by the live plugin so it works regardless of whether your opencode
 * install stores data as flat JSON or SQLite) build this same shape and
 * hand it to src/aggregate.ts#aggregate(), so the numbers are identical no
 * matter which source produced them.
 */
export interface NormalizedMessage {
  role: string;
  modelID?: string;
  providerID?: string;
  cost: number;
  tokens: TokenTotals;
  /** Tool names, one entry per call made in this message (e.g. ["read", "bash", "bash"]). */
  toolCalls: string[];
  /** Unix ms — when this message was created / when the assistant reply started. */
  createdAt?: number;
  /** Unix ms — when this message was completed (assistant replies only). */
  completedAt?: number;
}

export interface NormalizedSession {
  id: string;
  title: string;
  directory?: string;
  isSubagent: boolean;
  parentID?: string;
  createdAt?: number;
  updatedAt?: number;
  /**
   * Active effort in milliseconds — sum of per-turn durations where a turn
   * duration is the gap between a user message createdAt and the following
   * assistant message completedAt. Falls back to (updatedAt - createdAt) when
   * per-message timestamps are not available.
   */
  durationMs?: number;
  messages: NormalizedMessage[];
}

export interface NormalizedProject {
  id: string;
  name: string;
  worktree?: string;
  vcs?: string;
  sessions: NormalizedSession[];
}

export interface NormalizedData {
  /** Human-readable description of where this came from, e.g. a storage path or "opencode SDK". */
  source: string;
  /** True if the underlying data channel for tool calls appears populated at all (see notes in sdk-source.ts / storage.ts). */
  toolCallsAvailable: boolean;
  projects: NormalizedProject[];
}

// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate } from "./aggregate.ts";
import { dateRangeBounds, epochMs } from "./date-range.ts";
import type { DateRange, NormalizedData, NormalizedMessage, NormalizedProject, NormalizedSession, OverallStats, TokenTotals } from "./types.ts";
import { emptyTokenTotals } from "./types.ts";

function debugLog(msg: string) {
  try {
    const dir = join(process.env.HOME ?? "~", ".local", "share", "opencode", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "velocity-debug.log"), msg + "\n", { flag: "a" });
  } catch {}
}

/**
 * Primary data source for the *live* plugin.
 *
 * Uses the opencode SDK/HTTP API — works regardless of whether the install
 * stores data as flat JSON or SQLite.
 *
 * The SDK wraps every response in a RequestResult envelope:
 *   { data: <payload>, error: undefined }
 * or, for list endpoints that support pagination:
 *   { data: { data: [...], cursor: {...} }, error: undefined }
 *
 * We handle all these shapes in `extractArray` / `unwrapData`.
 */
export interface MinimalSdkClient {
  project?: { list?: (...args: unknown[]) => Promise<unknown> };
  experimental?: {
    session?: { list?: (...args: unknown[]) => Promise<unknown> };
  };
  session?: {
    list?: (...args: unknown[]) => Promise<unknown>;
    messages?: (...args: unknown[]) => Promise<unknown>;
  };
  v2?: {
    session?: {
      list?: (...args: unknown[]) => Promise<unknown>;
      messages?: (...args: unknown[]) => Promise<unknown>;
    };
  };
}

/** The experimental endpoint is the only SDK endpoint that lists sessions globally. */
export function hasGlobalSessionApi(client: MinimalSdkClient): boolean {
  return typeof client.experimental?.session?.list === "function";
}

interface RawProjectLike {
  id?: string;
  worktree?: string;
  vcs?: string;
  name?: string;
  [key: string]: unknown;
}

interface SessionPage {
  sessions: RawSessionLike[];
  nextCursor?: string | number;
}

interface RawSessionLike {
  id?: string;
  title?: string;
  directory?: string;
  // v2 API nests the directory under location
  location?: { directory?: string } | string;
  parentID?: string;
  projectID?: string;
  projectId?: string;
  project_id?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  model?: {
    id?: string;
    providerID?: string;
    variant?: string;
  };
  time?: { created?: number; updated?: number };
  [key: string]: unknown;
}

/** IDs that are placeholder/global values — not real per-project identifiers. */
const GENERIC_PROJECT_IDS = new Set(["global", "unknown", "default", ""]);

/** Extract the real working directory from a session, handling v1 and v2 shapes. */
function sessionDirectory(s: RawSessionLike): string | undefined {
  if (typeof s.location === "string") return s.location;
  return s.location?.directory ?? s.directory;
}

function tokensFromSession(s: RawSessionLike): TokenTotals {
  const t = s.tokens;
  if (!t) return emptyTokenTotals();
  return {
    input: t.input ?? 0,
    output: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0,
  };
}

function isToolCallPart(type: string | undefined): boolean {
  return type === "tool" || type === "tool_use" || type === "tool-invocation" || type === "tool_call";
}

function sessionProjectId(s: RawSessionLike): string {
  return s.projectID ?? s.projectId ?? s.project_id ?? "unknown";
}

/** Return true when a project ID is a non-specific placeholder. */
function isGenericProjectId(id: string): boolean {
  return GENERIC_PROJECT_IDS.has(id);
}

/** Try several plausible call shapes; return the first that resolves. */
async function tryCalls<T>(calls: Array<() => Promise<T>>): Promise<T | undefined> {
  for (const call of calls) {
    try {
      return await call();
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/**
 * Deeply unwrap the SDK response to find the actual array payload.
 *
 * Handles:
 *   1. Raw array                          → [ ... ]
 *   2. RequestResult envelope             → { data: [...], error: ... }
 *   3. Paginated response                 → { data: { data: [...], cursor: ... } }
 *   4. Nested envelope + pagination       → { data: { data: { data: [...] } } }
 */
function extractArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Level 1: unwrap { data: ... }
    if ("data" in obj && obj.data !== undefined && obj.data !== null) {
      const inner = obj.data;
      if (Array.isArray(inner)) return inner;
      // Paginated responses are commonly { data: { data: [...] } }, but
      // keep unwrapping so this also works through SDK result envelopes.
      const nested = extractArray(inner);
      if (nested.length > 0) return nested;
    }

    // A few SDK versions use `items` for the collection payload.
    if (Array.isArray(obj.items)) return obj.items;
  }

  return [];
}

function extractNextCursor(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const cursor = obj.cursor;
  if (cursor && typeof cursor === "object") {
    const next = (cursor as Record<string, unknown>).next;
    if (typeof next === "string" && next.length > 0) return next;
    if (typeof next === "number" && Number.isFinite(next)) return next;
  }
  if (typeof cursor === "number" && Number.isFinite(cursor)) return cursor;
  return extractNextCursor(obj.data);
}

function extractSessionPage(value: unknown): SessionPage {
  if (Array.isArray(value)) return { sessions: value as RawSessionLike[] };
  if (!value || typeof value !== "object") return { sessions: [] };

  const obj = value as Record<string, unknown>;
  const payload = obj.data;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const page = payload as Record<string, unknown>;
    const sessions = Array.isArray(page.data) ? page.data : Array.isArray(page.items) ? page.items : [];
    return { sessions: sessions as RawSessionLike[], nextCursor: extractNextCursor(page) };
  }
  if (Array.isArray(payload)) return { sessions: payload as RawSessionLike[] };
  return { sessions: Array.isArray(obj.items) ? obj.items as RawSessionLike[] : [] };
}

function extractHeaderCursor(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = (value as Record<string, unknown>).response;
  if (!response || typeof response !== "object") return undefined;
  const headers = (response as Record<string, unknown>).headers;
  if (!headers || typeof headers !== "object") return undefined;

  const get = (headers as { get?: (name: string) => unknown }).get;
  const raw = typeof get === "function"
    ? get.call(headers, "x-next-cursor")
    : (headers as Record<string, unknown>)["x-next-cursor"];
  const cursor = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(cursor) ? cursor : undefined;
}

function dedupeSessions(sessions: RawSessionLike[]): RawSessionLike[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (!session.id || seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

export async function buildStatsFromSdk(client: MinimalSdkClient, options: { dateRange?: DateRange } = {}): Promise<OverallStats> {
  // ── Projects ──────────────────────────────────────────────────────────────
  const rawProjectsResult = client.project?.list ? await tryCalls([
    () => client.project!.list!(),
    () => client.project!.list!({}),
  ]) : undefined;
  const rawProjects = extractArray(rawProjectsResult) as RawProjectLike[];
  debugLog(`[velocity] projects raw type=${typeof rawProjectsResult}, extracted ${rawProjects.length} projects`);

  const projectsById = new Map<string, NormalizedProject>();
  /** Derive a human-readable project name from a filesystem path. */
  const nameFromPath = (path: string): string => {
    const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : path;
  };

  const getProject = (id: string, worktreeHint?: string): NormalizedProject => {
    // When the project ID is a non-specific placeholder (e.g. "global", "unknown"),
    // group by the actual working directory path so each directory gets its own
    // project entry rather than everything collapsing into one bucket.
    const effectiveId = (isGenericProjectId(id) && worktreeHint) ? worktreeHint : id;

    let p = projectsById.get(effectiveId);
    if (!p) {
      // Only look up metadata from project.list() when we have a real project ID.
      const meta = isGenericProjectId(id) ? undefined : rawProjects.find((rp) => rp.id === id);
      const worktree = meta?.worktree ?? worktreeHint;
      // Reject degenerate worktrees like "/" that produce empty names.
      const validWorktree = worktree && worktree !== "/" ? worktree : undefined;
      p = {
        id: effectiveId,
        name: validWorktree ? nameFromPath(validWorktree) : effectiveId.slice(0, 12),
        worktree: validWorktree,
        vcs: meta?.vcs,
        sessions: [],
      };
      projectsById.set(effectiveId, p);
    }
    return p;
  };

  // Pre-seed only projects with valid, non-generic IDs and usable worktrees.
  for (const rp of rawProjects) {
    if (rp.id && !isGenericProjectId(rp.id) && rp.worktree && rp.worktree !== "/") {
      getProject(rp.id, rp.worktree);
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  // Fetch every page from the global endpoint. The experimental endpoint uses
  // a response header for its numeric cursor; newer v2 endpoints put it in
  // the JSON payload, so both forms are supported below.
  const rawSessions: RawSessionLike[] = [];

  try {
    if (client.experimental?.session?.list) {
      debugLog(`[velocity] fetching all sessions via experimental session.list() with roots`);
      let cursor: number | undefined = undefined;
      let page = 0;
      do {
        page++;
        // Explicitly request the cross-project endpoint. Do not pass a
        // directory, otherwise some OpenCode versions scope results to the
        // project hosting the TUI.
        const params: Record<string, unknown> = { limit: 200, roots: false };
        if (cursor !== undefined) params.cursor = cursor;
        const result = await (client.experimental.session.list as (p: unknown) => Promise<unknown>)(params);
        const pageData = extractSessionPage(result);
        rawSessions.push(...pageData.sessions);
        debugLog(`[velocity] experimental page ${page}: got ${pageData.sessions.length} sessions (total so far: ${rawSessions.length})`);
        const next = extractHeaderCursor(result) ?? extractNextCursor(result);
        cursor = next === undefined ? undefined : Number(next);
        if (cursor !== undefined && !Number.isFinite(cursor)) cursor = undefined;
        if (page > 50) break;
      } while (cursor !== undefined);

      debugLog(`[velocity] experimental pagination done: ${rawSessions.length} total sessions across ${page} page(s)`);
    } else if (client.v2?.session?.list) {
      debugLog(`[velocity] fetching sessions via v2 session.list() with pagination`);
      let cursor: string | undefined = undefined;
      let page = 0;
      do {
        page++;
        const params: Record<string, unknown> = { limit: 200 };
        if (cursor) params.cursor = cursor;
        const result = await (client.v2.session.list as (p: unknown) => Promise<unknown>)(params);
        debugLog(`[velocity] v2 page ${page} raw keys: ${result && typeof result === "object" ? Object.keys(result as object).join(", ") : String(result)}`);
        const pageData = extractSessionPage(result);
        const page_sessions = pageData.sessions;
        rawSessions.push(...page_sessions);
        debugLog(`[velocity] v2 page ${page}: got ${page_sessions.length} sessions (total so far: ${rawSessions.length})`);

        // Extract next cursor from either the SDK envelope or its payload.
        const next = pageData.nextCursor ?? extractNextCursor(result);
        cursor = typeof next === "string" ? next : undefined;

        if (page > 50) {
          debugLog(`[velocity] pagination safety limit reached, stopping`);
          break;
        }
      } while (cursor);

      debugLog(`[velocity] v2 pagination done: ${rawSessions.length} total sessions across ${page} page(s)`);
    } else if (client.session?.list) {
      debugLog(`[velocity] falling back to v1 session.list()`);
      const result = await client.session.list();
      rawSessions.push(...(extractArray(result) as RawSessionLike[]));
      debugLog(`[velocity] v1 session.list(): ${rawSessions.length} sessions`);
    }
  } catch (e: any) {
    debugLog(`[velocity] session.list() FAILED: ${e?.message ?? e}`);
  }

  if (rawSessions.length > 0) {
    debugLog(`[velocity] first session sample: ${JSON.stringify(rawSessions[0]).slice(0, 500)}`);
  }

  let anyPartsSeen = false;
  const rangeBounds = options.dateRange ? dateRangeBounds(options.dateRange) : undefined;

  for (const rawSession of dedupeSessions(rawSessions)) {
    if (!rawSession.id) continue;
    const activityTime = epochMs(rawSession.time?.updated ?? rawSession.time?.created);
    if (rangeBounds && activityTime !== undefined && (activityTime < rangeBounds.since || activityTime > rangeBounds.until)) {
      continue;
    }
    const directory = sessionDirectory(rawSession);
    const sessionId = sessionProjectId(rawSession);
    // Global listings from some server versions use a generic project ID.
    // Match by worktree before falling back to the directory bucket so
    // sessions from different projects do not collapse into one project.
    const projectMeta = rawProjects.find(
      (rp) => rp.id === sessionId || (directory && rp.worktree === directory),
    );
    const projectId = projectMeta?.id ?? sessionId;

    // Session-level summary (always available from session.list()).
    const sessionTokens = tokensFromSession(rawSession);
    const sessionCost = rawSession.cost ?? 0;
    const modelKey = rawSession.model?.providerID
      ? `${rawSession.model.providerID}/${rawSession.model.id ?? "unknown"}`
      : rawSession.model?.id;

    // Fetch per-message details (for tool calls and per-message token/cost).
    const rawMessages = await fetchMessages(client, rawSession.id);
    const normMessages: NormalizedMessage[] = [];

    for (const item of rawMessages) {
      const info = extractMessageInfo(item);
      const parts = extractMessageParts(item);
      if (parts.length > 0) anyPartsSeen = true;

      const msgToolCalls = parts
        .filter((p) => isToolCallPart(p.type))
        .map((p) => p.tool || p.name || "unknown");
      const msgTokens = info.tokens
        ? {
            input: info.tokens.input ?? 0,
            output: info.tokens.output ?? 0,
            reasoning: info.tokens.reasoning ?? 0,
            cacheRead: info.tokens.cache?.read ?? 0,
            cacheWrite: info.tokens.cache?.write ?? 0,
          }
        : emptyTokenTotals();

      normMessages.push({
        role: info.role ?? "unknown",
        modelID: info.modelID,
        providerID: info.providerID,
        cost: info.cost ?? 0,
        tokens: msgTokens,
        toolCalls: msgToolCalls,
        createdAt: info.time?.created,
        completedAt: info.time?.completed,
      });
    }

    // If no per-message data available, synthesize from session-level fields
    // so aggregate() still gets tokens, cost, and model usage.
    if (normMessages.length === 0 && (sessionCost > 0 || sumTokens(sessionTokens) > 0 || modelKey)) {
      normMessages.push({
        role: "assistant",
        modelID: modelKey,
        providerID: rawSession.model?.providerID,
        cost: sessionCost,
        tokens: sessionTokens,
        toolCalls: [],
      });
    }

    const normSession: NormalizedSession = {
      id: rawSession.id,
      title: rawSession.title ?? "",
      directory,
      isSubagent: Boolean(rawSession.parentID),
      createdAt: rawSession.time?.created,
      updatedAt: rawSession.time?.updated,
      durationMs: computeDurationMs(normMessages),
      messages: normMessages,
    };

    getProject(projectId, directory).sessions.push(normSession);
  }

  const data: NormalizedData = {
    source: "opencode SDK",
    toolCallsAvailable: anyPartsSeen,
    projects: [...projectsById.values()],
  };

  debugLog(`[velocity] SDK: ${rawProjects.length} projects, ${dedupeSessions(rawSessions).length} sessions, ${data.projects.reduce((a, p) => a + p.sessions.length, 0)} total sessions across projects`);

  return aggregate(data, options.dateRange);
}

// ── Message helpers ─────────────────────────────────────────────────────────

interface MessageInfo {
  role?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; completed?: number };
}

interface MessagePart {
  type?: string;
  tool?: string;
  name?: string;
}

/** Extract the message info from the various shapes the SDK might return. */
function extractMessageInfo(item: unknown): MessageInfo {
  if (!item || typeof item !== "object") return {};
  const obj = item as Record<string, unknown>;

  // Shape: { info: { role, tokens, time, ... }, parts: [...] }  (v1 API)
  if (obj.info && typeof obj.info === "object") {
    return obj.info as MessageInfo;
  }

  // Shape: { type: "assistant", cost, tokens, model, time, ... }  (v2 API)
  if ("type" in obj) {
    return {
      role: obj.type as string,
      modelID: typeof obj.model === "object" && obj.model !== null ? (obj.model as Record<string, unknown>).id as string : undefined,
      providerID: typeof obj.model === "object" && obj.model !== null ? (obj.model as Record<string, unknown>).providerID as string : undefined,
      cost: obj.cost as number | undefined,
      tokens: obj.tokens as MessageInfo["tokens"],
      time: obj.time as MessageInfo["time"],
    };
  }

  // Flat shape: { role, tokens, time, ... }
  return obj as unknown as MessageInfo;
}

/** Extract the parts array from the various shapes the SDK might return. */
function extractMessageParts(item: unknown): MessagePart[] {
  if (!item || typeof item !== "object") return [];
  const obj = item as Record<string, unknown>;

  // Shape: { info: ..., parts: [...] }  (v1 API)
  if (Array.isArray(obj.parts)) return obj.parts as MessagePart[];

  // Shape: { type: "assistant", content: [...] }  (v2 API)
  if (Array.isArray(obj.content)) {
    return (obj.content as unknown[]).map((c) => {
      if (!c || typeof c !== "object") return {};
      const part = c as Record<string, unknown>;
      return {
        type: part.type as string,
        tool: part.tool as string | undefined,
        name: part.name as string | undefined,
      };
    });
  }

  return [];
}

/** Fetch messages for a session. Tries V2 API first, then v1 shapes. */
async function fetchMessages(client: MinimalSdkClient, sessionId: string): Promise<unknown[]> {
  // Try V2 API first
  if (client.v2?.session?.messages) {
    try {
      const result = await client.v2.session.messages({ sessionID: sessionId });
      const arr = extractArray(result);
      if (arr.length > 0) return arr;
    } catch {}
  }
  // Fall back to v1 API with various call shapes
  if (client.session?.messages) {
    const result = await tryCalls([
      () => client.session!.messages!({ sessionID: sessionId }),
      () => client.session!.messages!({ path: { id: sessionId } }),
      () => client.session!.messages!(sessionId),
    ]);
    return extractArray(result);
  }
  return [];
}

function sumTokens(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

/**
 * Compute active effort in ms from a list of normalized messages.
 * For each user→assistant pair, measures the gap between user createdAt and
 * assistant completedAt (or createdAt as fallback). Caps each turn at 30 min
 * to exclude idle time. Returns undefined if no timestamps are available.
 */
function computeDurationMs(messages: NormalizedMessage[]): number | undefined {
  const MAX_TURN_MS = 30 * 60 * 1000;
  let total = 0;
  let hasAny = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || msg.createdAt === undefined) continue;

    // Measure to the LAST assistant message before the next user message so
    // the full agent loop (all tool-call replies) is included in the turn.
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

// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { RawProjectFile, RawSessionFile, RawMessageFile, RawPartFile } from "./types.ts";

/**
 * Resolve the opencode data directory root(s).
 *
 * opencode (and ccusage's opencode reader) respects OPENCODE_DATA_DIR, which
 * may be a single path or a comma-separated list of roots (for reading
 * backups/archives alongside the live directory). Falls back to the XDG
 * default of ~/.local/share/opencode.
 */
export function resolveDataDirs(explicit?: string): string[] {
  const raw = explicit ?? process.env.OPENCODE_DATA_DIR;
  if (raw && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".local", "share");
  return [join(base, "opencode")];
}

function safeReadJson<T>(path: string): T | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export interface DiscoveredStorage {
  dataDir: string;
  storageDir: string;
  projectDir: string;
  sessionDir: string;
  messageDir: string;
  exists: boolean;
}

export function discoverStorage(dataDir: string): DiscoveredStorage {
  const storageDir = join(dataDir, "storage");
  return {
    dataDir,
    storageDir,
    projectDir: join(storageDir, "project"),
    sessionDir: join(storageDir, "session"),
    messageDir: join(storageDir, "message"),
    exists: existsSync(storageDir),
  };
}

/** Load every project metadata file found under storage/project/*.json. */
export function loadProjects(storage: DiscoveredStorage): Map<string, RawProjectFile> {
  const out = new Map<string, RawProjectFile>();
  for (const entry of safeReadDir(storage.projectDir)) {
    if (!entry.endsWith(".json")) continue;
    const full = join(storage.projectDir, entry);
    const data = safeReadJson<RawProjectFile>(full);
    if (data && data.id) {
      out.set(data.id, data);
    } else {
      // Some opencode versions may name files without embedding `id` inside;
      // fall back to the filename (minus extension) as the id.
      const id = basename(entry, ".json");
      if (data) out.set(id, { ...data, id });
    }
  }
  return out;
}

export interface DiscoveredSession {
  projectId: string; // directory name under storage/session/, usually the project hash/id
  raw: RawSessionFile;
}

/**
 * Load every session file under storage/session/{projectId}/{sessionId}.json.
 * The directory name is treated as the authoritative project id, since it is
 * always present even when a session's own `projectID` field is missing on
 * older opencode versions.
 */
export function loadSessions(storage: DiscoveredStorage): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  for (const projectDirName of safeReadDir(storage.sessionDir)) {
    const projectPath = join(storage.sessionDir, projectDirName);
    let isDir = false;
    try {
      isDir = statSync(projectPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    for (const file of safeReadDir(projectPath)) {
      if (!file.endsWith(".json")) continue;
      const raw = safeReadJson<RawSessionFile>(join(projectPath, file));
      if (!raw) continue;
      const id = raw.id ?? basename(file, ".json");
      out.push({
        projectId: raw.projectID ?? projectDirName,
        raw: { ...raw, id },
      });
    }
  }
  return out;
}

/** Load every message file for a given session id, sorted by created time. */
export function loadMessagesForSession(storage: DiscoveredStorage, sessionId: string): RawMessageFile[] {
  const dir = join(storage.messageDir, sessionId);
  const messages: RawMessageFile[] = [];
  for (const file of safeReadDir(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = safeReadJson<RawMessageFile>(join(dir, file));
    if (raw) messages.push(raw);
  }
  messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return messages;
}

/**
 * Load every "part" file for a given message id (storage/part/{messageId}/*.json).
 * Best-effort: on some opencode installs/versions this directory exists but
 * is empty even for messages that made tool calls (tool results may be
 * tracked under storage/tool-output/ instead). Callers should treat an
 * empty result as "no part-level data available", not "zero tool calls".
 */
export function loadPartsForMessage(storage: DiscoveredStorage, messageId: string): RawPartFile[] {
  const dir = join(storage.storageDir, "part", messageId);
  const parts: RawPartFile[] = [];
  for (const file of safeReadDir(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = safeReadJson<RawPartFile>(join(dir, file));
    if (raw) parts.push(raw);
  }
  return parts;
}

/** Quick existence probe used by the CLI to give a helpful error message. */
export function describeMissingStorage(storage: DiscoveredStorage): string {
  return [
    `Could not find opencode storage at: ${storage.storageDir}`,
    "",
    "This tool reads opencode's local data directory directly (the same",
    "place opencode's own `stats` view and tools like ccusage read from).",
    "",
    "Things to check:",
    `  1. Has opencode been run at least once on this machine?`,
    `  2. Is OPENCODE_DATA_DIR set to a custom location? (currently: ${
      process.env.OPENCODE_DATA_DIR ?? "<unset>"
    })`,
    `  3. Try: ls "${storage.storageDir}"`,
    "",
    "You can generate synthetic local data for testing with:",
    "  npm run mock",
  ].join("\n");
}

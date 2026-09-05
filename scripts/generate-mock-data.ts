// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
#!/usr/bin/env node
/**
 * Generates a synthetic opencode storage tree under ./.mock-opencode-data
 * (or MOCK_DATA_DIR) that mirrors the real on-disk shape:
 *
 *   storage/project/{projectId}.json
 *   storage/session/{projectId}/{sessionId}.json
 *   storage/message/{sessionId}/msg_{n}.json
 *
 * Run it, then point the CLI/plugin at the generated directory:
 *
 *   node --experimental-strip-types scripts/generate-mock-data.ts
 *   OPENCODE_DATA_DIR=$(pwd)/.mock-opencode-data npm run report
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const OUT_DIR = process.env.MOCK_DATA_DIR ?? join(process.cwd(), ".mock-opencode-data");
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const MODELS = [
  { providerID: "anthropic", modelID: "claude-sonnet-4-5", inCost: 0.000003, outCost: 0.000015 },
  { providerID: "anthropic", modelID: "claude-haiku-4-5", inCost: 0.0000008, outCost: 0.000004 },
  { providerID: "openai", modelID: "gpt-5", inCost: 0.000005, outCost: 0.000015 },
];

const TOOLS = ["bash", "read", "write", "edit", "grep", "glob", "webfetch", "websearch", "task"];

const PROJECTS = [
  { slug: "storefront-web", worktree: "/home/dev/code/storefront-web", vcs: "git", sessions: 9, activity: 30 },
  { slug: "billing-service", worktree: "/home/dev/code/billing-service", vcs: "git", sessions: 5, activity: 20 },
  { slug: "infra-terraform", worktree: "/home/dev/code/infra-terraform", vcs: "git", sessions: 2, activity: 60 },
  { slug: "notes-cli", worktree: "/home/dev/code/notes-cli", vcs: "git", sessions: 1, activity: 90 },
];

function rand(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  const storageDir = join(OUT_DIR, "storage");
  const projectDir = join(storageDir, "project");
  const sessionDir = join(storageDir, "session");
  const messageDir = join(storageDir, "message");
  const partDir = join(storageDir, "part");
  ensureDir(projectDir);
  ensureDir(sessionDir);
  ensureDir(messageDir);
  ensureDir(partDir);

  for (const proj of PROJECTS) {
    const projectId = `proj_${proj.slug}_${randomUUID().slice(0, 8)}`;
    writeJson(join(projectDir, `${projectId}.json`), {
      id: projectId,
      worktree: proj.worktree,
      vcs: proj.vcs,
      time: { created: now - proj.activity * DAY, initialized: now - proj.activity * DAY },
    });

    const projSessionDir = join(sessionDir, projectId);
    ensureDir(projSessionDir);

    for (let s = 0; s < proj.sessions; s++) {
      const sessionId = `ses_${randomUUID().slice(0, 12)}`;
      const createdAt = now - rand(0, proj.activity) * DAY;
      const updatedAt = createdAt + rand(60_000, 3 * DAY);
      writeJson(join(projSessionDir, `${sessionId}.json`), {
        id: sessionId,
        projectID: projectId,
        title: `${["Fix", "Add", "Refactor", "Investigate", "Wire up"][rand(0, 5)]} ${
          ["auth flow", "checkout bug", "CI pipeline", "rate limiter", "dashboard widget"][rand(0, 5)]
        }`,
        directory: proj.worktree,
        version: "1.0.0",
        time: { created: createdAt, updated: updatedAt },
      });

      const msgDir = join(messageDir, sessionId);
      ensureDir(msgDir);
      const replyCount = rand(1, 8);
      let t = createdAt;
      for (let m = 0; m < replyCount; m++) {
        t += rand(30_000, 10 * 60_000);
        // user message
        writeJson(join(msgDir, `msg_${String(m * 2).padStart(4, "0")}.json`), {
          id: `msg_${randomUUID().slice(0, 10)}`,
          role: "user",
          sessionID: sessionId,
          time: { created: t },
        });
        t += rand(2_000, 30_000);
        const model = MODELS[rand(0, MODELS.length)];
        const inputTok = rand(200, 6000);
        const outputTok = rand(100, 2000);
        const cacheRead = rand(0, 4000);
        const cacheWrite = rand(0, 1500);
        const cost = inputTok * model.inCost + outputTok * model.outCost;
        const assistantMsgId = `msg_${randomUUID().slice(0, 10)}`;
        writeJson(join(msgDir, `msg_${String(m * 2 + 1).padStart(4, "0")}.json`), {
          id: assistantMsgId,
          role: "assistant",
          sessionID: sessionId,
          providerID: model.providerID,
          modelID: model.modelID,
          mode: "build",
          cost,
          tokens: {
            input: inputTok,
            output: outputTok,
            reasoning: rand(0, 500),
            cache: { read: cacheRead, write: cacheWrite },
          },
          time: { created: t, completed: t + rand(1000, 20000) },
        });

        // A handful of tool-call parts per assistant message, mirroring
        // storage/part/{messageId}/*.json (see src/types.ts RawPartFile).
        const toolCallCount = rand(0, 4);
        if (toolCallCount > 0) {
          const partMsgDir = join(partDir, assistantMsgId);
          ensureDir(partMsgDir);
          for (let p = 0; p < toolCallCount; p++) {
            const tool = TOOLS[rand(0, TOOLS.length)];
            writeJson(join(partMsgDir, `prt_${String(p).padStart(4, "0")}.json`), {
              id: `prt_${randomUUID().slice(0, 10)}`,
              messageID: assistantMsgId,
              sessionID: sessionId,
              type: "tool",
              tool,
              callID: `call_${randomUUID().slice(0, 8)}`,
              state: { status: "completed", time: { start: t, end: t + rand(100, 5000) } },
            });
          }
        }
      }
    }
  }

  console.log(`Mock opencode storage written to: ${OUT_DIR}`);
  console.log(`Try it:`);
  console.log(`  OPENCODE_DATA_DIR="${OUT_DIR}" node --experimental-strip-types src/cli.ts`);
}

main();

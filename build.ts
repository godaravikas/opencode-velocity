// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/velocity.ts"],
  outdir: "dist",
  target: "bun",
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/sdk",
    "solid-js",
    "@opentui/solid",
    "@opentui/core",
    "@opentui/keymap",
  ],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

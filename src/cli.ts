// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { buildStats } from "./engine.ts";
import { buildStatsFromDb, resolveDatabasePath } from "./db-source.ts";
import { renderMarkdownReport, renderOverviewReport, renderProjectDetail } from "./format.ts";
import { renderHtmlReport } from "./html-report.ts";
import { loadCreditConfig, type CreditConfig } from "./credits.ts";
import { discoverStorage, resolveDataDirs, describeMissingStorage } from "./storage.ts";

interface Args {
  json: boolean;
  markdown: boolean;
  html?: string; // output path, or "" to print to stdout
  dataDir?: string;
  source: "files" | "db";
  project?: string;
  top: number;
  help: boolean;
  dollarsPerCredit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, markdown: false, source: "files", top: 10, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        args.json = true;
        break;
      case "--markdown":
      case "--md":
        args.markdown = true;
        break;
      case "--html":
        // Optional output path: `--html report.html`. If the next arg looks
        // like another flag (or is missing), print to stdout instead.
        if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
          args.html = argv[++i];
        } else {
          args.html = "";
        }
        break;
      case "--data-dir":
        args.dataDir = argv[++i];
        break;
      case "--source":
        if (argv[i + 1] === "db" || argv[i + 1] === "files") {
          args.source = argv[++i] as Args["source"];
        } else {
          console.error("--source must be either files or db");
          args.help = true;
        }
        break;
      case "--db":
        args.source = "db";
        break;
      case "--dollars-per-credit": {
        const val = Number(argv[++i]);
        if (Number.isFinite(val) && val > 0) {
          args.dollarsPerCredit = val;
        } else {
          console.error("--dollars-per-credit must be a positive number (e.g. 0.02)");
          args.help = true;
        }
        break;
      }
      case "--project":
        args.project = argv[++i];
        break;
      case "--top":
        args.top = Number(argv[++i]) || args.top;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          args.help = true;
        }
    }
  }
  return args;
}

function printHelp() {
  console.log(`opencode-velocity — cross-project token/cost dashboard

Usage:
  opencode-velocity [options]

Options:
  --json                print machine-readable JSON instead of a formatted report
  --markdown, --md       print a full Markdown report (all projects + sessions)
  --html [path]          write a self-contained HTML report with charts (default: stdout)
  --project <name|id>    drill into a single project (matches name substring or id)
  --top <n>              how many projects to list in the overview table (default 10)
  --data-dir <path>      override the opencode data directory (or set OPENCODE_DATA_DIR)
  --source <files|db>    choose JSON storage (default) or the read-only SQLite database
  --db                   shorthand for --source db
  --dollars-per-credit <n>  set the dollar value of 1 credit for reports (default: loaded from ~/.config/opencode/velocity-credits.json or 0.01)
  -h, --help              show this help

Examples:
  bun run src/cli.ts
  bun run src/cli.ts --project my-app
  bun run src/cli.ts --json > stats.json
  bun run src/cli.ts --markdown > report.md
  bun run src/cli.ts --html velocity-report.html

In opencode itself, this same report is available as the /velocity slash command
(the "d" key inside it, or /velocity-download, saves the HTML report shown above).
`);
}

function jsonReplacer(_key: string, value: unknown) {
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const dirs = resolveDataDirs(args.dataDir);
  const dbPath = args.source === "db" ? resolveDatabasePath(args.dataDir) : undefined;
  const anyExists = args.source === "db"
    ? Boolean(dbPath && existsSync(dbPath))
    : dirs.some((d) => existsSync(discoverStorage(d).storageDir));
  if (!anyExists) {
    console.error(args.source === "db"
      ? `Could not find the opencode SQLite database at: ${dbPath}`
      : describeMissingStorage(discoverStorage(dirs[0])));
    process.exitCode = 1;
    return;
  }

  // Resolve credit config: CLI flag > persisted config > default
  const creditConfig: CreditConfig = args.dollarsPerCredit !== undefined
    ? { dollarsPerCredit: args.dollarsPerCredit }
    : loadCreditConfig();

  const stats = args.source === "db"
    ? await buildStatsFromDb(args.dataDir)
    : buildStats({ dataDir: args.dataDir });

  if (args.project) {
    const needle = args.project.toLowerCase();
    const project = stats.projects.find((p) => p.id === args.project || p.name.toLowerCase().includes(needle));
    if (!project) {
      console.error(`No project matched "${args.project}". Known projects:`);
      for (const p of stats.projects) console.error(`  - ${p.name} (${p.id})`);
      process.exitCode = 1;
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(project, jsonReplacer, 2));
    } else {
      console.log(renderProjectDetail(project, creditConfig));
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(stats, jsonReplacer, 2));
    return;
  }

  if (args.html !== undefined) {
    const html = renderHtmlReport(stats, creditConfig);
    if (args.html === "") {
      console.log(html);
    } else {
      writeFileSync(args.html, html);
      console.error(`Wrote ${args.html}`);
    }
    return;
  }

  if (args.markdown) {
    console.log(renderMarkdownReport(stats, creditConfig));
    return;
  }

  console.log(renderOverviewReport(stats, { topProjects: args.top, creditConfig }));
}

await main();

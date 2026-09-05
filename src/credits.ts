// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CreditConfig {
  dollarsPerCredit: number;
}

export const DEFAULT_CREDIT_CONFIG: CreditConfig = { dollarsPerCredit: 0.01 };

export function creditsFromCost(cost: number, config: CreditConfig = DEFAULT_CREDIT_CONFIG): number {
  return Math.round(cost / config.dollarsPerCredit);
}

/** Resolve the path where the persisted credit config is stored. */
function configFilePath(): string {
  const base =
    process.env.OPENCODE_CONFIG_DIR ??
    join(process.env.HOME ?? "~", ".config", "opencode");
  return join(base, "velocity-credits.json");
}

/** Load the persisted credit config, or return the default if none is saved. */
export function loadCreditConfig(): CreditConfig {
  try {
    const raw = readFileSync(configFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CreditConfig>;
    const dollarsPerCredit = Number(parsed.dollarsPerCredit);
    if (Number.isFinite(dollarsPerCredit) && dollarsPerCredit > 0) {
      return { dollarsPerCredit };
    }
  } catch {
    // file missing or malformed — use default
  }
  return { ...DEFAULT_CREDIT_CONFIG };
}

/** Persist the credit config to disk so it survives restarts. */
export function saveCreditConfig(config: CreditConfig): void {
  const path = configFilePath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// Copyright (c) 2026 Vikas Godara
// SPDX-License-Identifier: MIT
import type { DateRange } from "./types.ts";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateInput(value: string): string | undefined {
  const normalized = value.trim();
  const match = DATE_PATTERN.exec(normalized);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }

  return normalized;
}

export function dateRangeBounds(range: DateRange): { since: number; until: number } {
  const [startYear, startMonth, startDay] = range.start.split("-").map(Number);
  const [endYear, endMonth, endDay] = range.end.split("-").map(Number);
  return {
    since: new Date(startYear, startMonth - 1, startDay).getTime(),
    until: new Date(endYear, endMonth - 1, endDay, 23, 59, 59, 999).getTime(),
  };
}

/** OpenCode timestamps have existed in both seconds and milliseconds. */
export function epochMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}

export function dateToInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateRange(range?: DateRange): string {
  return range ? `${range.start} - ${range.end}` : "All Available Data";
}

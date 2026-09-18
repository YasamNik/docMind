export type DateFilterPreset = "all" | "today" | "7d" | "30d" | "mtd" | "ytd" | "90d" | "custom";

export type DateFilterValue = {
  preset: DateFilterPreset;
  start?: string;
  end?: string;
};

export const DATE_FILTER_OPTIONS: { value: DateFilterPreset; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "mtd", label: "Month to date" },
  { value: "ytd", label: "Year to date" },
  { value: "90d", label: "Last 90 days" },
  { value: "custom", label: "Custom range" },
];

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parses either a full ISO timestamp or a plain YYYY-MM-DD date. Date-only values are
// read as local calendar dates so they line up with the local day boundaries below,
// instead of shifting a day when the local timezone is behind UTC.
function parseFlexibleDate(value: string): Date | null {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function daysBefore(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - days);
  return copy;
}

export function resolveDateRange(filter: DateFilterValue, now: Date = new Date()): { start: Date | null; end: Date | null } {
  switch (filter.preset) {
    case "all":
      return { start: null, end: null };
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "7d":
      return { start: startOfDay(daysBefore(now, 6)), end: endOfDay(now) };
    case "30d":
      return { start: startOfDay(daysBefore(now, 29)), end: endOfDay(now) };
    case "mtd":
      return { start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0), end: endOfDay(now) };
    case "ytd":
      return { start: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0), end: endOfDay(now) };
    case "90d":
      return { start: startOfDay(daysBefore(now, 89)), end: endOfDay(now) };
    case "custom": {
      const start = filter.start ? startOfDay(parseFlexibleDate(filter.start) ?? now) : null;
      const end = filter.end ? endOfDay(parseFlexibleDate(filter.end) ?? now) : null;
      return { start, end };
    }
    default:
      return { start: null, end: null };
  }
}

export function matchesDateFilter(value: string | null, filter: DateFilterValue, now: Date = new Date()): boolean {
  if (filter.preset === "all") return true;
  const { start, end } = resolveDateRange(filter, now);
  if (!value) return false;
  const parsed = parseFlexibleDate(value);
  if (!parsed) return false;
  if (start && parsed < start) return false;
  if (end && parsed > end) return false;
  return true;
}

export function dateFilterBadgeLabel(filter: DateFilterValue): string | null {
  if (filter.preset === "all") return null;
  if (filter.preset === "custom") {
    if (!filter.start || !filter.end) return null;
    return `${filter.start} to ${filter.end}`;
  }
  return DATE_FILTER_OPTIONS.find((o) => o.value === filter.preset)?.label ?? null;
}

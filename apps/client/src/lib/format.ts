export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The document date is a plain YYYY-MM-DD calendar date with no time component. It is
// formatted from its digits directly rather than through the Date constructor, which
// would read it as UTC midnight and could display a day off in timezones behind UTC.
export function formatDocumentDate(value: string | null) {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "-";
  const [, year, month, day] = match;
  return `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}, ${year}`;
}

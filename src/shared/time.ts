const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

/** Local calendar date, YYYY-MM-DD. */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local time with its UTC offset, e.g. 2026-11-16T10:42:00+01:00 (readable and unambiguous). */
export function localIsoDateTime(d: Date = new Date()): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${localIsoDate(d)}T${time}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

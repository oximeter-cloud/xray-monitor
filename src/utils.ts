export function parseFormattedBytes(str: string | null | undefined): number {
  if (!str || str === "0") return 0;
  const match = String(str).trim().match(/^([0-9.]+)\s*([A-Za-z]+)?$/);
  if (!match) return 0;
  const num = parseFloat(match[1] || "0");
  const unit = (match[2] || "B").toUpperCase();
  if (unit.startsWith("T")) return Math.round(num * 1024 * 1024 * 1024 * 1024);
  if (unit.startsWith("G")) return Math.round(num * 1024 * 1024 * 1024);
  if (unit.startsWith("M")) return Math.round(num * 1024 * 1024);
  if (unit.startsWith("K")) return Math.round(num * 1024);
  return Math.round(num);
}

/**
 * Timezone & date utilities for Tehran (Asia/Tehran)
 */
export function formatToTehranTime(dateOrStr: Date | string | number | null | undefined): string {
  if (!dateOrStr) return "-";
  try {
    let d: Date;
    if (typeof dateOrStr === "number" || /^\d{10,13}$/.test(String(dateOrStr).trim())) {
      const num = Number(dateOrStr);
      d = new Date(num < 1e11 ? num * 1000 : num);
    } else {
      let s = String(dateOrStr).trim();
      if (!s.includes("T") && s.includes(" ")) s = s.replace(" ", "T") + "Z";
      else if (!s.endsWith("Z") && !s.includes("+")) s += "Z";
      d = new Date(s);
    }

    if (isNaN(d.getTime())) return String(dateOrStr);

    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .format(d)
      .replace(",", "");
  } catch {
    return String(dateOrStr);
  }
}

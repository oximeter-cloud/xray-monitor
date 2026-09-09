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

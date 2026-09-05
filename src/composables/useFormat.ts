// 数字 / 日期格式化工具

/** 大数格式化：支持 K / M / B 缩写，可指定小数位 */
export function formatNumber(n: number, digits = 1): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  return Math.round(n).toString();
}

/** 完整千分位 */
export function formatInteger(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 百分比（0~1 → "95.7%"） */
export function formatPercent(rate: number, digits = 1): string {
  if (!isFinite(rate)) return "0%";
  return (rate * 100).toFixed(digits) + "%";
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function timeAgo(ts: number | null): string {
  if (!ts) return "从未同步";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/** 时间戳 → 短日期 "09-04 09:53" */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期字符串 → "9月4日" */
export function humanDate(s: string): string {
  const [, m, d] = s.split("-");
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

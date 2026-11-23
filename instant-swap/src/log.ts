/**
 * Minimal structured logger. Never pass secrets, keys, mnemonics or user IPs to it.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Level[] = ["debug", "info", "warn", "error"];
const min = (process.env.LOG_LEVEL as Level) ?? "info";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER.indexOf(level) < ORDER.indexOf(min)) return;
  const line = JSON.stringify(
    { t: new Date().toISOString(), level, msg, ...fields },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};

export async function fetchJson<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text.slice(0, 500), url);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body}`);
  }
}

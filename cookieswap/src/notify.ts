import type { Config } from "./config";
import { log } from "./log";

/** Private operator alerts. Never shown to customers. */
export interface Notifier {
  send(text: string): Promise<void>;
}

async function post(url: string, body: unknown, what: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  // The URL is left out of errors on purpose: Telegram's contains the bot token.
  if (!res.ok) throw new Error(`${what} alert failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private chatId: string,
    private api: string,
  ) {}

  async send(text: string): Promise<void> {
    await post(`${this.api}/bot${this.token}/sendMessage`, { chat_id: this.chatId, text, disable_web_page_preview: true }, "telegram");
  }
}

/** Generic JSON webhook: Slack reads `text`, Discord reads `content` (max 2000 chars). */
export class WebhookNotifier implements Notifier {
  constructor(private url: string) {}

  async send(text: string): Promise<void> {
    await post(this.url, { text, content: text.slice(0, 2000) }, "webhook");
  }
}

/** Mock/dev mode without a channel: the alert goes to the server log. */
export class LogNotifier implements Notifier {
  async send(text: string): Promise<void> {
    log.warn("operator alert (no alert channel configured)", { text });
  }
}

/** Sends to every channel; succeeds when at least one delivered it, so a retry can't spam the working ones forever. */
export class MultiNotifier implements Notifier {
  constructor(private channels: Notifier[]) {}

  async send(text: string): Promise<void> {
    const results = await Promise.allSettled(this.channels.map((c) => c.send(text)));
    const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    if (failed.length === results.length) throw new Error(`every alert channel failed: ${failed.join("; ")}`);
    for (const f of failed) log.error("alert channel failed", { err: f });
  }
}

export function createNotifier(cfg: Config): Notifier {
  const channels: Notifier[] = [];
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
    channels.push(new TelegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID, cfg.TELEGRAM_API_URL));
  }
  if (cfg.ALERT_WEBHOOK_URL) channels.push(new WebhookNotifier(cfg.ALERT_WEBHOOK_URL));
  if (channels.length === 0) return new LogNotifier(); // loadConfig refuses live chains without a channel
  return channels.length === 1 ? channels[0] : new MultiNotifier(channels);
}

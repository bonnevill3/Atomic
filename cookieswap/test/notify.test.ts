import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createNotifier, LogNotifier, MultiNotifier, TelegramNotifier, WebhookNotifier } from "../src/notify";

const TOKEN = "123456:secret-bot-token";
let server: Server;
let base = "";
let hits: { url: string; body: any }[] = [];
let status = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url!, body: JSON.parse(body) });
      res.statusCode = status;
      res.end(status === 200 ? '{"ok":true}' : '{"ok":false,"description":"chat not found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  hits = [];
  status = 200;
});

describe("alert channels", () => {
  it("Telegram: sendMessage to the configured chat", async () => {
    await new TelegramNotifier(TOKEN, "-100777", base).send("hello\nworld");
    expect(hits).toEqual([{ url: `/bot${TOKEN}/sendMessage`, body: { chat_id: "-100777", text: "hello\nworld", disable_web_page_preview: true } }]);
  });

  it("Telegram errors never contain the bot token", async () => {
    status = 400;
    const err = await new TelegramNotifier(TOKEN, "-1", base).send("x").catch((e: Error) => e);
    expect(String(err)).toMatch(/telegram alert failed: HTTP 400/);
    expect(String(err)).not.toContain("secret-bot-token");
  });

  it("webhook: Slack/Discord-compatible JSON", async () => {
    await new WebhookNotifier(`${base}/hook`).send("big order");
    expect(hits).toEqual([{ url: "/hook", body: { text: "big order", content: "big order" } }]);
  });

  it("several channels: one working channel is enough, all failing throws", async () => {
    const ok = new WebhookNotifier(`${base}/hook`);
    const down = new WebhookNotifier("http://127.0.0.1:1/unreachable");
    await expect(new MultiNotifier([down, ok]).send("x")).resolves.toBeUndefined();
    await expect(new MultiNotifier([down, down]).send("x")).rejects.toThrow(/every alert channel failed/);
  });
});

describe("alert configuration", () => {
  const live = { CHAINS: "live", MNEMONIC: "x", ADMIN_TOKEN: "a".repeat(32) };

  it("refuses live chains without an alert channel", () => {
    expect(() => loadConfig(live as NodeJS.ProcessEnv)).toThrow(/requires an alert channel/);
    expect(loadConfig({ ...live, ALERT_WEBHOOK_URL: "https://hooks.example.com/x" } as NodeJS.ProcessEnv).ALERT_WEBHOOK_URL).toBeTruthy();
    expect(loadConfig({ ...live, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "1" } as NodeJS.ProcessEnv).TELEGRAM_CHAT_ID).toBe("1");
  });

  it("refuses half a Telegram config", () => {
    expect(() => loadConfig({ CHAINS: "mock", TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toThrow(/both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/);
  });

  it("mock mode without a channel logs alerts instead", () => {
    expect(createNotifier(loadConfig({ CHAINS: "mock" } as NodeJS.ProcessEnv))).toBeInstanceOf(LogNotifier);
    const both = createNotifier(loadConfig({ CHAINS: "mock", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "1", ALERT_WEBHOOK_URL: "https://h.example.com" } as NodeJS.ProcessEnv));
    expect(both).toBeInstanceOf(MultiNotifier);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GryphonConfig } from "../src/config.js";
import { GryphonError, GryphonGateway } from "../src/gateway.js";
import { GryphonRepository } from "../src/repository.js";
import type { CommandEnvelope, CommandResponse, TelegramTransport } from "../src/types.js";

const temporary: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const current of temporary.splice(0)) fs.rmSync(current, { recursive: true, force: true });
});

function fixture(identities: Readonly<Record<string, { readonly id: string; readonly username: string }>>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-test-"));
  temporary.push(directory);
  const sent: Array<{ readonly botId: string; readonly chatId: string; readonly text: string; readonly replyMarkup?: Readonly<Record<string, unknown>> }> = [];
  const callbacks: Array<{ readonly botId: string; readonly id: string; readonly text?: string }> = [];
  const webhooks: Array<{ readonly botId: string; readonly url: string }> = [];
  const envelopes: CommandEnvelope[] = [];
  let transientCommand: string | undefined;
  const config: GryphonConfig = {
    version: "0.1.0-test",
    dataDirectory: directory,
    publicOrigin: "https://gryphon.test",
    publicHost: "127.0.0.1",
    publicPort: 18380,
    adminSocket: path.join(directory, "admin.sock"),
    clientSocket: path.join(directory, "client.sock"),
    telegramApiBaseUrl: "https://api.telegram.org/",
    providerTimeoutMs: 1_000,
    webhookMaxBytes: 65_536,
    webhookMaxConnections: 8,
  };
  const repository = new GryphonRepository(path.join(directory, "gryphon.sqlite"));
  const transportFactory = (token: string): TelegramTransport => {
    const identity = identities[token];
    if (identity === undefined) throw new GryphonError("invalid_bot_token");
    return {
      getMe: () => Promise.resolve({ id: identity.id, isBot: true, username: identity.username }),
      setWebhook: (input) => { webhooks.push({ botId: identity.id, url: input.url }); return Promise.resolve(); },
      sendMessage: (input) => { sent.push({ botId: identity.id, ...input }); return Promise.resolve(); },
      answerCallbackQuery: (input) => { callbacks.push({ botId: identity.id, id: input.callbackQueryId, ...(input.text === undefined ? {} : { text: input.text }) }); return Promise.resolve(); },
    };
  };
  const adapterDispatcher = (_connection: unknown, token: string, envelope: CommandEnvelope): Promise<CommandResponse> => {
    expect(token).toBe("service-secret-token-value-0001");
    if (transientCommand === envelope.command) {
      transientCommand = undefined;
      throw new Error("transient adapter failure");
    }
    envelopes.push(envelope);
    return Promise.resolve({
      schema: "exocortex.telegram.response.v1",
      actions: envelope.command === "start"
        ? [{ type: "send_message", text: `${envelope.serviceId} ready`, buttons: [[{ text: "Status", command: "status" }]] }]
        : [{ type: "send_message", text: `${envelope.serviceId}:${envelope.command}` }],
    });
  };
  const gateway = new GryphonGateway({ repository, config, pepper: Buffer.alloc(32, 7), transportFactory, adapterDispatcher });
  return { gateway, repository, sent, callbacks, webhooks, envelopes, failNext: (command: string) => { transientCommand = command; } };
}

function message(updateId: number, userId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Owner" }, text } };
}

describe("Gryphon gateway", () => {
  it("reuses one bot runtime for two services using the same bot token", async () => {
    const token = "100000:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const test = fixture({ [token]: { id: "10", username: "shared_bot" } });
    const first = await test.gateway.connect({ serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "personal", botToken: token, serviceToken: "service-secret-token-value-0001" });
    const second = await test.gateway.connect({ serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "also-personal", botToken: token, serviceToken: "saturn-service-secret-token-0002" });

    expect(first.reusedBot).toBe(false);
    expect(second.reusedBot).toBe(true);
    expect(second.bot.id).toBe(first.bot.id);
    expect(test.repository.listBots()).toHaveLength(1);
    expect(test.repository.listConnections()).toHaveLength(2);
    expect(test.webhooks).toHaveLength(1);
    test.repository.close();
  });

  it("creates independent runtimes for different Telegram bots", async () => {
    const one = "100001:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const two = "100002:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const test = fixture({ [one]: { id: "11", username: "chronos_bot" }, [two]: { id: "12", username: "saturn_bot" } });
    await test.gateway.connect({ serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: one, serviceToken: "service-secret-token-value-0001" });
    await test.gateway.connect({ serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "saturn", botToken: two, serviceToken: "saturn-service-secret-token-0002" });
    expect(test.repository.listBots()).toHaveLength(2);
    expect(test.webhooks).toHaveLength(2);
    test.repository.close();
  });

  it("uses a CLI-issued one-time code and isolates bindings per service", async () => {
    const token = "100003:cccccccccccccccccccccccccccccccc";
    const test = fixture({ [token]: { id: "13", username: "shared_bot" } });
    const chronos = await test.gateway.connect({ serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "personal", botToken: token, serviceToken: "service-secret-token-value-0001" });
    await test.gateway.connect({ serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "ignored", botToken: token, serviceToken: "saturn-service-secret-token-0002" });
    const challenge = test.gateway.issueLink("chronos");

    expect(challenge.command).toMatch(/^\/link [A-HJ-NP-Z2-9]{8}$/);
    expect(test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(1, 42, challenge.command))).toEqual({ accepted: true });
    expect(test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(1, 42, challenge.command))).toEqual({ accepted: false });
    await test.gateway.drain();

    const status = test.gateway.status() as { readonly connections: readonly { readonly serviceId: string; readonly linked: boolean }[] };
    expect(status.connections).toEqual([
      expect.objectContaining({ serviceId: "chronos", linked: true }),
      expect.objectContaining({ serviceId: "saturn", linked: false }),
    ]);
    expect(test.sent.at(-1)?.text).toBe("chronos linked to this Telegram account.");

    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(2, 42, "/chronos status"));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(3, 42, "/saturn status"));
    await test.gateway.drain();
    expect(test.envelopes).toHaveLength(1);
    expect(test.envelopes[0]).toMatchObject({ serviceId: "chronos", command: "status", actor: { telegramUserId: "42", chatId: "42" } });
    expect(test.sent.map((item) => item.text)).toContain("saturn is not linked to this Telegram account.");
    await expect(test.gateway.revokeLink("chronos")).resolves.toEqual({ revoked: true });
    expect(test.envelopes.at(-1)).toMatchObject({ serviceId: "chronos", command: "binding_revoked", actor: { telegramUserId: "42", chatId: "42" } });
    expect((test.gateway.status() as { readonly connections: readonly { readonly serviceId: string; readonly linked: boolean }[] }).connections)
      .toContainEqual(expect.objectContaining({ serviceId: "chronos", linked: false }));
    test.repository.close();
  });

  it("rejects reusing a service credential across two service identities", async () => {
    const one = "100006:ffffffffffffffffffffffffffffffff";
    const two = "100007:gggggggggggggggggggggggggggggggg";
    const test = fixture({ [one]: { id: "16", username: "chronos_bot" }, [two]: { id: "17", username: "saturn_bot" } });
    await test.gateway.connect({ serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: one, serviceToken: "service-secret-token-value-0001" });
    await expect(test.gateway.connect({ serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "saturn", botToken: two, serviceToken: "service-secret-token-value-0001" }))
      .rejects.toMatchObject({ code: "service_token_already_used", status: 409 });
    test.repository.close();
  });

  it("binds callback tokens to the linked user and connection", async () => {
    const token = "100004:dddddddddddddddddddddddddddddddd";
    const test = fixture({ [token]: { id: "14", username: "callback_bot" } });
    const connected = await test.gateway.connect({ serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
    const challenge = test.gateway.issueLink("chronos");
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(1, 42, challenge.command));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(2, 42, "/chronos"));
    await test.gateway.drain();
    const markup = test.sent.at(-1)?.replyMarkup as { readonly inline_keyboard: readonly (readonly { readonly callback_data: string }[])[] };
    const callbackToken = markup.inline_keyboard[0]![0]!.callback_data;
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, {
      update_id: 3,
      callback_query: { id: "callback-1", from: { id: 42, is_bot: false }, message: { chat: { id: 42, type: "private" } }, data: callbackToken },
    });
    await test.gateway.drain();
    expect(test.envelopes.at(-1)?.command).toBe("status");
    expect(test.callbacks.at(-1)).toMatchObject({ id: "callback-1", text: "Done" });
    test.repository.close();
  });

  it("keeps a callback usable when its service adapter fails transiently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = "100005:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const test = fixture({ [token]: { id: "15", username: "retry_bot" } });
    const connected = await test.gateway.connect({ serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
    const challenge = test.gateway.issueLink("chronos");
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(1, 42, challenge.command));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(2, 42, "/chronos"));
    await test.gateway.drain();
    const markup = test.sent.at(-1)?.replyMarkup as { readonly inline_keyboard: readonly (readonly { readonly callback_data: string }[])[] };
    const callbackToken = markup.inline_keyboard[0]![0]!.callback_data;
    test.failNext("status");
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, {
      update_id: 3,
      callback_query: { id: "callback-retry", from: { id: 42, is_bot: false }, message: { chat: { id: 42, type: "private" } }, data: callbackToken },
    });
    await test.gateway.drain();
    expect(test.envelopes.at(-1)?.command).toBe("start");

    vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
    await test.gateway.drain();
    expect(test.envelopes.at(-1)?.command).toBe("status");
    expect(test.callbacks.at(-1)).toMatchObject({ id: "callback-retry", text: "Done" });
    test.repository.close();
  });
});

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
  const commandSets: Array<{ readonly botId: string; readonly chatId?: string; readonly commands: readonly { readonly command: string; readonly description: string }[] }> = [];
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
    clientsDirectory: path.join(directory, "clients"),
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
      setCommands: (input) => { commandSets.push({ botId: identity.id, ...input }); return Promise.resolve(); },
      sendMessage: (input) => { sent.push({ botId: identity.id, ...input }); return Promise.resolve(); },
      answerCallbackQuery: (input) => { callbacks.push({ botId: identity.id, id: input.callbackQueryId, ...(input.text === undefined ? {} : { text: input.text }) }); return Promise.resolve(); },
    };
  };
  const adapterDispatcher = (_connection: unknown, token: string, envelope: CommandEnvelope): Promise<CommandResponse> => {
    expect(token).toBe(envelope.serviceId === "saturn" ? "saturn-service-secret-token-0002" : "service-secret-token-value-0001");
    if (transientCommand === envelope.command) {
      transientCommand = undefined;
      throw new Error("transient adapter failure");
    }
    envelopes.push(envelope);
    const keyboard = {
      persistent: true as const,
      resize: true,
      placeholder: "Select the current category",
      rows: [
        [{ text: "Recovery", command: "press", arguments: { category: "recovery" } }, { text: "Accumulation", command: "press", arguments: { category: "accumulation" } }],
        [{ text: "Execution", command: "press", arguments: { category: "execution" } }, { text: "Maintenance", command: "press", arguments: { category: "maintenance" } }],
      ],
    };
    const actions: CommandResponse["actions"] = envelope.command === "start"
      ? [{ type: "send_message", text: `${envelope.serviceId} ready`, buttons: [[{ text: "Status", command: "status" }]] }]
      : envelope.command === "menu"
        ? [{ type: "send_message", text: "Select the current activity.", replyKeyboard: keyboard }]
        : envelope.command === "backfill" && envelope.arguments.text === ""
          ? [{ type: "send_message", text: "How many recent minutes should become a completed session?", expectInput: { command: "backfill_minutes", expiresInSeconds: 300 } }]
          : envelope.command === "backfill_minutes" && !/^[1-9]\d*$/.test(String(envelope.arguments.text ?? ""))
            ? [{ type: "send_message", text: "Enter a whole number of minutes.", expectInput: { command: "backfill_minutes", expiresInSeconds: 300 } }]
            : envelope.command === "backfill_minutes"
              ? [{ type: "send_message", text: "Select a category.", buttons: [[{ text: "Recovery", command: "backfill_select", arguments: { category: "recovery" } }]] }]
            : [{ type: "send_message", text: `${envelope.serviceId}:${envelope.command}` }];
    return Promise.resolve({
      schema: "exocortex.telegram.response.v1",
      actions,
    });
  };
  const gateway = new GryphonGateway({ repository, config, pepper: Buffer.alloc(32, 7), transportFactory, adapterDispatcher });
  return { gateway, repository, config, sent, callbacks, webhooks, commandSets, envelopes, transportFactory, adapterDispatcher, failNext: (command: string) => { transientCommand = command; } };
}

async function connect(test: ReturnType<typeof fixture>, input: {
  readonly serviceId: string;
  readonly commandPrefix: string;
  readonly adapterUrl: string;
  readonly alias: string;
  readonly botToken: string;
  readonly serviceToken: string;
}) {
  fs.mkdirSync(test.config.clientsDirectory, { recursive: true });
  fs.writeFileSync(path.join(test.config.clientsDirectory, `${input.serviceId}.token`), input.serviceToken);
  const connected = await test.gateway.connectBot({ alias: input.alias, botToken: input.botToken });
  test.gateway.connectService(`Bearer ${input.serviceToken}`, {
    botId: connected.bot.id,
    commandPrefix: input.commandPrefix,
    adapterUrl: input.adapterUrl,
  });
  return { ...connected, connection: test.repository.getConnectionByService(input.serviceId)! };
}

function message(updateId: number, userId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Owner" }, text } };
}

describe("Gryphon gateway", () => {
  it("reuses one bot runtime for two services using the same bot token", async () => {
    const token = "100000:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const test = fixture({ [token]: { id: "10", username: "shared_bot" } });
    const first = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "personal", botToken: token, serviceToken: "service-secret-token-value-0001" });
    const second = await connect(test, { serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "also-personal", botToken: token, serviceToken: "saturn-service-secret-token-0002" });

    expect(first.reusedBot).toBe(false);
    expect(second.reusedBot).toBe(true);
    expect(second.bot.id).toBe(first.bot.id);
    expect(test.repository.listBots()).toHaveLength(1);
    expect(test.repository.listConnections()).toHaveLength(2);
    expect(test.webhooks).toHaveLength(1);
    expect(test.commandSets[0]).toMatchObject({
      botId: "10",
      commands: expect.arrayContaining([
        { command: "start", description: "Open the Gryphon menu" },
        { command: "help", description: "Show available commands" },
      ]),
    });
    test.repository.close();
  });

  it("creates independent runtimes for different Telegram bots", async () => {
    const one = "100001:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const two = "100002:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const test = fixture({ [one]: { id: "11", username: "chronos_bot" }, [two]: { id: "12", username: "saturn_bot" } });
    const chronos = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: one, serviceToken: "service-secret-token-value-0001" });
    await connect(test, { serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "saturn", botToken: two, serviceToken: "saturn-service-secret-token-0002" });
    expect(test.repository.listBots()).toHaveLength(2);
    expect(test.webhooks).toHaveLength(2);
    expect(test.gateway.serviceBots("Bearer service-secret-token-value-0001")).toMatchObject({
      serviceId: "chronos",
      bots: [
        { id: chronos.bot.id, alias: "chronos", selected: true },
        { alias: "saturn", selected: false },
      ],
    });
    test.repository.close();
  });

  it("uses a CLI-issued one-time code and isolates bindings per service", async () => {
    const token = "100003:cccccccccccccccccccccccccccccccc";
    const test = fixture({ [token]: { id: "13", username: "shared_bot" } });
    const chronos = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "personal", botToken: token, serviceToken: "service-secret-token-value-0001" });
    await connect(test, { serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "ignored", botToken: token, serviceToken: "saturn-service-secret-token-0002" });
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
    expect(test.sent.map((item) => item.text)).toContain("chronos linked to this Telegram account.");

    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(2, 42, "/chronos status"));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(3, 42, "/saturn status"));
    await test.gateway.drain();
    expect(test.envelopes.filter((item) => item.command === "status")).toHaveLength(1);
    expect(test.envelopes.find((item) => item.command === "status")).toMatchObject({ serviceId: "chronos", command: "status", actor: { telegramUserId: "42", chatId: "42" } });
    expect(test.sent.map((item) => item.text)).toContain("saturn is not linked to this Telegram account.");
    await expect(test.gateway.revokeLink("chronos")).resolves.toEqual({ revoked: true });
    expect(test.envelopes.at(-1)).toMatchObject({ serviceId: "chronos", command: "binding_revoked", actor: { telegramUserId: "42", chatId: "42" } });
    expect((test.gateway.status() as { readonly connections: readonly { readonly serviceId: string; readonly linked: boolean }[] }).connections)
      .toContainEqual(expect.objectContaining({ serviceId: "chronos", linked: false }));
    test.repository.close();
  });

  it("rejects ambiguous service credentials provisioned for two identities", async () => {
    const one = "100006:ffffffffffffffffffffffffffffffff";
    const two = "100007:gggggggggggggggggggggggggggggggg";
    const test = fixture({ [one]: { id: "16", username: "chronos_bot" }, [two]: { id: "17", username: "saturn_bot" } });
    fs.mkdirSync(test.config.clientsDirectory, { recursive: true });
    fs.writeFileSync(path.join(test.config.clientsDirectory, "chronos.token"), "service-secret-token-value-0001");
    fs.writeFileSync(path.join(test.config.clientsDirectory, "saturn.token"), "service-secret-token-value-0001");
    const bot = await test.gateway.connectBot({ alias: "chronos", botToken: one });
    await test.gateway.connectBot({ alias: "saturn", botToken: two });
    expect(() => test.gateway.connectService("Bearer service-secret-token-value-0001", { botId: bot.bot.id, commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command" }))
      .toThrowError(expect.objectContaining({ code: "ambiguous_service_token", status: 409 }));
    test.repository.close();
  });

  it("limits a service connection to its own command prefix and adapter host", async () => {
    const token = "100008:hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh";
    const test = fixture({ [token]: { id: "18", username: "chronos_bot" } });
    fs.mkdirSync(test.config.clientsDirectory, { recursive: true });
    fs.writeFileSync(path.join(test.config.clientsDirectory, "chronos.token"), "service-secret-token-value-0001");
    const bot = await test.gateway.connectBot({ alias: "chronos", botToken: token });
    expect(() => test.gateway.connectService("Bearer service-secret-token-value-0001", { botId: bot.bot.id, commandPrefix: "saturn", adapterUrl: "http://chronos.test/internal/gryphon/command" }))
      .toThrowError(expect.objectContaining({ code: "invalid_command_prefix" }));
    expect(() => test.gateway.connectService("Bearer service-secret-token-value-0001", { botId: bot.bot.id, commandPrefix: "chronos", adapterUrl: "http://saturn.test/internal/gryphon/command" }))
      .toThrowError(expect.objectContaining({ code: "invalid_adapter_url" }));
    expect(test.gateway.connectService("Bearer service-secret-token-value-0001", { botId: bot.bot.id, commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command" }))
      .toMatchObject({ serviceId: "chronos", connected: true });
    test.repository.close();
  });

  it("binds callback tokens to the linked user and connection", async () => {
    const token = "100004:dddddddddddddddddddddddddddddddd";
    const test = fixture({ [token]: { id: "14", username: "callback_bot" } });
    const connected = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
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
    const connected = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
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

  it("routes unique service commands and builds help and Telegram menus from one catalog", async () => {
    const token = "100009:iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii";
    const test = fixture({ [token]: { id: "19", username: "catalog_bot" } });
    const chronos = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "shared", botToken: token, serviceToken: "service-secret-token-value-0001" });
    await connect(test, { serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "same", botToken: token, serviceToken: "saturn-service-secret-token-0002" });
    test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [
        { name: "timer", adapterCommand: "menu", description: "Open activity controls" },
        { name: "active", adapterCommand: "status", description: "Show the active timer" },
      ],
    });
    test.gateway.syncServiceCommandCatalog("Bearer saturn-service-secret-token-0002", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [
        { name: "drop", adapterCommand: "drop", description: "Create a Drop Point code" },
        { name: "drop_status", adapterCommand: "status", description: "Show Drop Point status" },
      ],
    });
    const chronosLink = test.gateway.issueLink("chronos");
    const saturnLink = test.gateway.issueLink("saturn");
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(1, 42, chronosLink.command));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(2, 42, saturnLink.command));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(3, 42, "/timer"));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(4, 42, "/drop"));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(5, 42, "/help"));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(6, 42, "/chronos_status"));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(7, 42, "/saturn drop"));
    await test.gateway.drain();

    expect(test.envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: `${chronos.bot.id}:3`, serviceId: "chronos", command: "menu" }),
      expect.objectContaining({ eventId: `${chronos.bot.id}:4`, serviceId: "saturn", command: "drop" }),
      expect.objectContaining({ eventId: `${chronos.bot.id}:6`, serviceId: "chronos", command: "status" }),
      expect.objectContaining({ eventId: `${chronos.bot.id}:7`, serviceId: "saturn", command: "drop" }),
    ]));
    const scopedMenu = test.commandSets.filter((item) => item.chatId === "42").at(-1)!;
    expect(scopedMenu.commands).toEqual(expect.arrayContaining([
      { command: "timer", description: "Open activity controls" },
      { command: "drop", description: "Create a Drop Point code" },
    ]));
    const help = test.sent.find((item) => item.text.includes("Available commands:"))?.text ?? "";
    expect(help).toContain("/timer — Open activity controls");
    expect(help).toContain("/drop — Create a Drop Point code");
    expect(help).not.toContain("/chronos_status");
    test.repository.close();
  });

  it("keeps command catalogs transactional when two services claim the same bot command", async () => {
    const token = "100010:jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj";
    const test = fixture({ [token]: { id: "20", username: "conflict_bot" } });
    await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "shared", botToken: token, serviceToken: "service-secret-token-value-0001" });
    await connect(test, { serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "same", botToken: token, serviceToken: "saturn-service-secret-token-0002" });
    test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "timer", adapterCommand: "menu", description: "Open activity controls" }],
    });
    test.gateway.syncServiceCommandCatalog("Bearer saturn-service-secret-token-0002", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "drop", adapterCommand: "drop", description: "Create a Drop Point code" }],
    });

    expect(() => test.gateway.syncServiceCommandCatalog("Bearer saturn-service-secret-token-0002", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "timer", adapterCommand: "drop", description: "Conflicting command" }],
    })).toThrowError(expect.objectContaining({ code: "command_conflict", status: 409 }));
    expect(test.repository.listConnectionCommands(test.repository.getConnectionByService("saturn")!.id))
      .toEqual([expect.objectContaining({ name: "drop", adapterCommand: "drop" })]);
    expect(() => test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "help", adapterCommand: "menu", description: "Reserved" }],
    })).toThrowError(expect.objectContaining({ code: "command_conflict", status: 409 }));
    test.repository.close();
  });

  it("scopes Telegram command menus to the services linked in each private chat", async () => {
    const token = "100011:kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
    const test = fixture({ [token]: { id: "21", username: "scoped_bot" } });
    const chronos = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "shared", botToken: token, serviceToken: "service-secret-token-value-0001" });
    await connect(test, { serviceId: "saturn", commandPrefix: "saturn", adapterUrl: "http://saturn.test/internal/gryphon/command", alias: "same", botToken: token, serviceToken: "saturn-service-secret-token-0002" });
    test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "timer", adapterCommand: "menu", description: "Open activity controls" }],
    });
    test.gateway.syncServiceCommandCatalog("Bearer saturn-service-secret-token-0002", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "drop", adapterCommand: "drop", description: "Create a Drop Point code" }],
    });
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(1, 42, test.gateway.issueLink("chronos").command));
    test.gateway.acceptUpdate(chronos.bot.webhookKey, chronos.bot.webhookSecret, message(2, 43, test.gateway.issueLink("saturn").command));
    await test.gateway.drain();

    const chronosMenu = test.commandSets.filter((item) => item.chatId === "42").at(-1)!.commands.map((item) => item.command);
    const saturnMenu = test.commandSets.filter((item) => item.chatId === "43").at(-1)!.commands.map((item) => item.command);
    expect(chronosMenu).toContain("timer");
    expect(chronosMenu).not.toContain("drop");
    expect(saturnMenu).toContain("drop");
    expect(saturnMenu).not.toContain("timer");
    test.repository.close();
  });

  it("maps persistent reply keyboard text only for the linked user and removes it on disconnect", async () => {
    const token = "100012:llllllllllllllllllllllllllllllll";
    const test = fixture({ [token]: { id: "22", username: "keyboard_bot" } });
    const connected = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
    test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "timer", adapterCommand: "menu", description: "Open activity controls" }],
    });
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(1, 42, test.gateway.issueLink("chronos").command));
    await test.gateway.drain();
    expect(test.sent.some((item) => Array.isArray(item.replyMarkup?.keyboard))).toBe(true);

    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(2, 42, "Recovery"));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(3, 43, "Recovery"));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(4, 42, "/timer"));
    await test.gateway.drain();
    expect(test.envelopes.filter((item) => item.command === "press")).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ telegramUserId: "42" }), arguments: { category: "recovery" } }),
    ]);
    expect(test.sent.filter((item) => Array.isArray(item.replyMarkup?.keyboard))).toHaveLength(2);

    expect(test.gateway.disconnectService("Bearer service-secret-token-value-0001")).toEqual({ disconnected: true });
    await test.gateway.drain();
    expect(test.sent.some((item) => item.replyMarkup?.remove_keyboard === true)).toBe(true);
    test.repository.close();
  });

  it("persists pending input, repeats it through the adapter and clears it on cancel and unlink", async () => {
    const token = "100013:mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
    const test = fixture({ [token]: { id: "23", username: "pending_bot" } });
    const connected = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
    test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "backfill", adapterCommand: "backfill", description: "Add recent time" }],
    });
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(1, 42, test.gateway.issueLink("chronos").command));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(2, 42, "/backfill"));
    await test.gateway.drain();
    test.repository.close();

    const reopenedRepository = new GryphonRepository(path.join(test.config.dataDirectory, "gryphon.sqlite"));
    const reopened = new GryphonGateway({
      repository: reopenedRepository,
      config: test.config,
      pepper: Buffer.alloc(32, 7),
      transportFactory: test.transportFactory,
      adapterDispatcher: test.adapterDispatcher,
    });
    await reopened.initialize();
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(3, 43, "30"));
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(4, 42, "not-a-number"));
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(5, 42, "30"));
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(6, 42, "45"));
    await reopened.drain();
    expect(test.envelopes.filter((item) => item.command === "backfill_minutes").map((item) => item.arguments.text)).toEqual(["not-a-number", "30"]);
    expect(test.sent.some((item) => item.text === "Enter a whole number of minutes.")).toBe(true);
    expect(test.sent.some((item) => item.text === "Select a category." && Array.isArray(item.replyMarkup?.inline_keyboard))).toBe(true);

    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(7, 42, "/backfill"));
    await reopened.drain();
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(8, 42, "/cancel"));
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(9, 42, "30"));
    await reopened.drain();
    expect(test.envelopes.filter((item) => item.command === "backfill_minutes")).toHaveLength(2);
    expect(test.sent.some((item) => item.text === "Pending input cancelled.")).toBe(true);

    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(10, 42, "/backfill"));
    await reopened.drain();
    await reopened.revokeLink("chronos");
    reopened.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(11, 42, "30"));
    await reopened.drain();
    expect(test.envelopes.filter((item) => item.command === "backfill_minutes")).toHaveLength(2);
    expect(test.envelopes.some((item) => item.command === "cancel")).toBe(false);
    reopenedRepository.close();
  });

  it("expires pending input without dispatching it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = "100014:nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";
    const test = fixture({ [token]: { id: "24", username: "expiry_bot" } });
    const connected = await connect(test, { serviceId: "chronos", commandPrefix: "chronos", adapterUrl: "http://chronos.test/internal/gryphon/command", alias: "chronos", botToken: token, serviceToken: "service-secret-token-value-0001" });
    test.gateway.syncServiceCommandCatalog("Bearer service-secret-token-value-0001", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: [{ name: "backfill", adapterCommand: "backfill", description: "Add recent time" }],
    });
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(1, 42, test.gateway.issueLink("chronos").command));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(2, 42, "/backfill"));
    await test.gateway.drain();
    vi.setSystemTime(new Date("2026-01-01T00:05:01.000Z"));
    test.gateway.acceptUpdate(connected.bot.webhookKey, connected.bot.webhookSecret, message(3, 42, "30"));
    await test.gateway.drain();
    expect(test.envelopes.some((item) => item.command === "backfill_minutes")).toBe(false);
    test.repository.close();
  });
});

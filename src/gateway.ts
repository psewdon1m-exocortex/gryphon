import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GryphonConfig } from "./config.js";
import { CommandConflictError, GryphonRepository, ReplyKeyboardConflictError } from "./repository.js";
import { TelegramHttpTransport } from "./telegram.js";
import { registeredOrigin } from "./kernel.js";
import { nativeFetch } from "./http-transport.js";
import type {
  AdapterDispatcher,
  BotRecord,
  CommandCatalogEntry,
  CommandEnvelope,
  CommandResponse,
  ConnectionRecord,
  ResponseAction,
  TelegramActor,
  TelegramCommand,
  TransportFactory,
} from "./types.js";

const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SERVICE_ID = /^[a-z][a-z0-9-]{1,47}$/;
const COMMAND_PREFIX = /^[a-z][a-z0-9_]{1,31}$/;
const COMMAND_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const SYSTEM_COMMANDS = [
  { command: "start", description: "Open the Gryphon menu" },
  { command: "help", description: "Show available commands" },
  { command: "services", description: "Show linked services" },
  { command: "link", description: "Link a service with a code" },
  { command: "cancel", description: "Cancel pending input" },
] as const satisfies readonly TelegramCommand[];
const RESERVED_COMMANDS = new Set([...SYSTEM_COMMANDS.map((item) => item.command), "status"]);
const MAX_TELEGRAM_COMMANDS = 100;

export class GryphonError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

function secretEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function sanitizedError(error: unknown): string {
  return error instanceof GryphonError ? error.code : "operation_failed";
}

function retryAt(attempts: number): Date {
  const milliseconds = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
  return new Date(Date.now() + milliseconds);
}

function readSecret(filename: string): string {
  try {
    return fs.readFileSync(filename, "utf8").replace(/[\r\n]+$/, "");
  } catch (error) {
    throw new GryphonError("secret_unavailable", 503);
  }
}

function writeSecret(filename: string, value: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(filename, 0o600); } catch { /* Windows has no POSIX mode enforcement. */ }
}

function responseButton(value: unknown): { readonly text: string; readonly command: string; readonly arguments?: Readonly<Record<string, unknown>> } {
  if (typeof value !== "object" || value === null) throw new GryphonError("invalid_adapter_response", 502);
  const item = value as Record<string, unknown>;
  if (typeof item.text !== "string" || item.text.length < 1 || item.text.length > 64 || typeof item.command !== "string" || !COMMAND_NAME.test(item.command)) {
    throw new GryphonError("invalid_adapter_response", 502);
  }
  if (item.arguments !== undefined && (typeof item.arguments !== "object" || item.arguments === null || Array.isArray(item.arguments))) {
    throw new GryphonError("invalid_adapter_response", 502);
  }
  return {
    text: item.text,
    command: item.command,
    ...(item.arguments === undefined ? {} : { arguments: item.arguments as Readonly<Record<string, unknown>> }),
  };
}

function buttonRows(value: unknown): readonly (readonly ReturnType<typeof responseButton>[])[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new GryphonError("invalid_adapter_response", 502);
  return value.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 8) throw new GryphonError("invalid_adapter_response", 502);
    return row.map(responseButton);
  });
}

function action(value: unknown): ResponseAction {
  if (typeof value !== "object" || value === null) throw new GryphonError("invalid_adapter_response", 502);
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "send_message" || typeof candidate.text !== "string" || candidate.text.length < 1 || candidate.text.length > 4_096) {
    throw new GryphonError("invalid_adapter_response", 502);
  }
  if (candidate.buttons !== undefined && candidate.replyKeyboard !== undefined) throw new GryphonError("invalid_adapter_response", 502);
  const buttons = candidate.buttons === undefined ? undefined : buttonRows(candidate.buttons);
  let replyKeyboard: ResponseAction["replyKeyboard"];
  if (candidate.replyKeyboard !== undefined) {
    const keyboard = record(candidate.replyKeyboard);
    if (keyboard === undefined || keyboard.persistent !== true || typeof keyboard.resize !== "boolean") throw new GryphonError("invalid_adapter_response", 502);
    if (keyboard.placeholder !== undefined && (typeof keyboard.placeholder !== "string" || keyboard.placeholder.length < 1 || keyboard.placeholder.length > 64)) {
      throw new GryphonError("invalid_adapter_response", 502);
    }
    const rows = buttonRows(keyboard.rows);
    const labels = rows.flat().map((item) => item.text);
    if (new Set(labels).size !== labels.length) throw new GryphonError("invalid_adapter_response", 502);
    replyKeyboard = {
      persistent: true,
      resize: keyboard.resize,
      ...(typeof keyboard.placeholder === "string" ? { placeholder: keyboard.placeholder } : {}),
      rows,
    };
  }
  let expectInput: ResponseAction["expectInput"];
  if (candidate.expectInput !== undefined) {
    const expected = record(candidate.expectInput);
    if (expected === undefined || typeof expected.command !== "string" || !COMMAND_NAME.test(expected.command)
      || typeof expected.expiresInSeconds !== "number" || !Number.isInteger(expected.expiresInSeconds)
      || expected.expiresInSeconds < 1 || expected.expiresInSeconds > 3_600) {
      throw new GryphonError("invalid_adapter_response", 502);
    }
    expectInput = { command: expected.command, expiresInSeconds: expected.expiresInSeconds };
  }
  return {
    type: "send_message",
    text: candidate.text,
    ...(buttons === undefined ? {} : { buttons }),
    ...(replyKeyboard === undefined ? {} : { replyKeyboard }),
    ...(expectInput === undefined ? {} : { expectInput }),
  };
}

function response(value: unknown): CommandResponse {
  if (typeof value !== "object" || value === null) throw new GryphonError("invalid_adapter_response", 502);
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "exocortex.telegram.response.v1" || !Array.isArray(candidate.actions) || candidate.actions.length > 8) {
    throw new GryphonError("invalid_adapter_response", 502);
  }
  return { schema: candidate.schema, actions: candidate.actions.map(action) };
}

function telegramCommands(value: unknown): readonly TelegramCommand[] {
  if (!Array.isArray(value) || value.length > MAX_TELEGRAM_COMMANDS) throw new GryphonError("invalid_delivery");
  return value.map((raw) => {
    const item = record(raw);
    if (item === undefined || typeof item.command !== "string" || !COMMAND_NAME.test(item.command)
      || typeof item.description !== "string" || item.description.length < 1 || item.description.length > 256) {
      throw new GryphonError("invalid_delivery");
    }
    return { command: item.command, description: item.description };
  });
}

const defaultDispatcher: AdapterDispatcher = async (connection, token, envelope) => {
  let remote: Response;
  try {
    remote = await nativeFetch(connection.adapterUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Request-ID": envelope.correlationId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new GryphonError("adapter_unavailable", 503);
  }
  if (!remote.ok) throw new GryphonError(remote.status === 401 ? "adapter_authentication_failed" : "adapter_request_failed", 502);
  return response(await remote.json());
};

interface RawMessage {
  readonly chatId: string;
  readonly chatType: string;
  readonly userId?: string;
  readonly isBot?: boolean;
  readonly displayName?: string;
  readonly text?: string;
}

interface RawCallback {
  readonly id: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly userId: string;
  readonly isBot: boolean;
  readonly displayName?: string;
  readonly data?: string;
}

interface ServiceCredential {
  readonly serviceId: string;
  readonly tokenPath: string;
  readonly connection?: ConnectionRecord;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rawMessage(update: unknown): RawMessage | undefined {
  const message = record(record(update)?.message);
  const chat = record(message?.chat);
  if (message === undefined || chat === undefined || typeof chat.id !== "number" || typeof chat.type !== "string") return undefined;
  const from = record(message.from);
  const first = typeof from?.first_name === "string" ? from.first_name : "";
  const last = typeof from?.last_name === "string" ? from.last_name : "";
  const displayName = [first, last].filter(Boolean).join(" ");
  return {
    chatId: String(chat.id),
    chatType: chat.type,
    ...(typeof from?.id === "number" ? { userId: String(from.id) } : {}),
    ...(typeof from?.is_bot === "boolean" ? { isBot: from.is_bot } : {}),
    ...(displayName ? { displayName } : {}),
    ...(typeof message.text === "string" ? { text: message.text } : {}),
  };
}

function rawCallback(update: unknown): RawCallback | undefined {
  const callback = record(record(update)?.callback_query);
  const from = record(callback?.from);
  const chat = record(record(callback?.message)?.chat);
  if (callback === undefined || from === undefined || chat === undefined || typeof callback.id !== "string" || typeof from.id !== "number" || typeof from.is_bot !== "boolean" || typeof chat.id !== "number" || typeof chat.type !== "string") return undefined;
  const first = typeof from.first_name === "string" ? from.first_name : "";
  const last = typeof from.last_name === "string" ? from.last_name : "";
  const displayName = [first, last].filter(Boolean).join(" ");
  return {
    id: callback.id,
    chatId: String(chat.id),
    chatType: chat.type,
    userId: String(from.id),
    isBot: from.is_bot,
    ...(displayName ? { displayName } : {}),
    ...(typeof callback.data === "string" ? { data: callback.data } : {}),
  };
}

export class GryphonGateway {
  readonly #repository: GryphonRepository;
  readonly #config: GryphonConfig;
  readonly #pepper: Buffer;
  readonly #transportFactory: TransportFactory;
  readonly #adapterDispatcher: AdapterDispatcher;
  readonly #registeredOrigins = new Map<string, string>();
  readonly #initializedBots = new Set<string>();
  #draining = false;

  constructor(input: {
    readonly repository: GryphonRepository;
    readonly config: GryphonConfig;
    readonly pepper: Buffer;
    readonly transportFactory?: TransportFactory;
    readonly adapterDispatcher?: AdapterDispatcher;
  }) {
    if (input.pepper.byteLength < 32) throw new Error("Gryphon pepper must contain at least 32 bytes");
    this.#repository = input.repository;
    this.#config = input.config;
    this.#pepper = input.pepper;
    this.#transportFactory = input.transportFactory ?? ((token) => new TelegramHttpTransport({
      token,
      baseUrl: this.#config.telegramApiBaseUrl,
      timeoutMs: this.#config.providerTimeoutMs,
    }));
    this.#adapterDispatcher = input.adapterDispatcher ?? (async (connection, token, envelope) => {
      const origin = await registeredOrigin(this.#config, connection.serviceId);
      return defaultDispatcher({ ...connection, adapterUrl: new URL("/internal/gryphon/command", origin).toString() }, token, envelope);
    });
  }

  async initialize(): Promise<void> {
    for (const current of this.#repository.listBots()) {
      await this.#initializeBot(current).catch(() => undefined);
    }
  }

  async connectBot(input: {
    readonly alias: string;
    readonly botToken: string;
  }): Promise<{ readonly bot: BotRecord; readonly reusedBot: boolean }> {
    if (!this.#config.publicOrigin && !this.#config.kernelOrigin) throw new GryphonError("public_origin_not_configured", 409);
    if (!SERVICE_ID.test(input.alias)) throw new GryphonError("invalid_bot_alias");
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(input.botToken)) throw new GryphonError("invalid_bot_token");
    const transport = this.#transportFactory(input.botToken);
    const identity = await transport.getMe();
    if (!identity.isBot) throw new GryphonError("telegram_identity_is_not_bot");
    const fingerprint = createHmac("sha256", this.#pepper).update(input.botToken, "utf8").digest("hex");
    let current = this.#repository.getBotByTelegramId(identity.id);
    const reusedBot = current !== undefined;
    if (current !== undefined && !secretEqual(current.tokenFingerprint, fingerprint)) throw new GryphonError("bot_token_rotation_required", 409);
    if (current === undefined) {
      const tokenPath = path.join(this.#config.dataDirectory, "secrets", `bot-${identity.id}.token`);
      writeSecret(tokenPath, input.botToken);
      current = this.#repository.createBot({
        telegramBotId: identity.id,
        alias: input.alias,
        ...(identity.username === undefined ? {} : { username: identity.username }),
        tokenPath,
        tokenFingerprint: fingerprint,
        webhookKey: randomBytes(18).toString("base64url"),
        webhookSecret: randomBytes(32).toString("base64url"),
      }, new Date());
    }
    await this.#initializeBot(current);
    return { bot: this.#repository.getBotById(current.id)!, reusedBot };
  }

  async #initializeBot(current: BotRecord): Promise<void> {
    if (current.state === "disabled") return;
    try {
      const transport = this.#transportFactory(readSecret(current.tokenPath));
      const identity = await transport.getMe();
      if (!identity.isBot || identity.id !== current.telegramBotId) throw new GryphonError("bot_identity_changed");
      const origin = this.#config.kernelOrigin ? await registeredOrigin(this.#config, "gryphon") : this.#config.publicOrigin;
      if (origin && (current.state !== "ready" || this.#registeredOrigins.get(current.id) !== origin)) {
        await transport.setWebhook({
          url: `${origin}/v1/telegram/webhook/${current.webhookKey}`,
          secretToken: current.webhookSecret,
          maxConnections: this.#config.webhookMaxConnections,
        });
        this.#registeredOrigins.set(current.id, origin);
      }
      if (!this.#initializedBots.has(current.id)) {
        await this.#setBotCommandMenus(transport, current.id);
        this.#initializedBots.add(current.id);
      }
      this.#repository.setBotState(current.id, "ready", new Date());
    } catch (error) {
      this.#repository.setBotState(current.id, "degraded", new Date());
      throw error;
    }
  }

  status(): Readonly<Record<string, unknown>> {
    return {
      schema: "exocortex.gryphon.status.v1",
      version: this.#config.version,
      bots: this.botStatus().bots,
      connections: this.#repository.listConnections().map((current) => ({
        id: current.id,
        serviceId: current.serviceId,
        botId: current.botId,
        commandPrefix: current.commandPrefix,
        state: current.state,
        linked: this.#repository.getBinding(current.id) !== undefined,
      })),
    };
  }

  botStatus(): { readonly schema: string; readonly version: string; readonly bots: readonly Readonly<Record<string, unknown>>[] } {
    return {
      schema: "exocortex.gryphon.bots.v1",
      version: this.#config.version,
      bots: this.#repository.listBots().map((current) => ({ id: current.id, alias: current.alias, telegramBotId: current.telegramBotId, username: current.username, state: current.state })),
    };
  }

  #commandsForActor(botId: string, telegramUserId: string, chatId: string): readonly TelegramCommand[] {
    return [
      ...SYSTEM_COMMANDS,
      ...this.#repository.listCommandsForActor(botId, telegramUserId, chatId).map((item) => ({
        command: item.name,
        description: item.description,
      })),
    ];
  }

  #boundActors(botId: string): readonly { readonly telegramUserId: string; readonly chatId: string }[] {
    const actors = new Map<string, { readonly telegramUserId: string; readonly chatId: string }>();
    for (const binding of this.#repository.listBindingsForBot(botId)) {
      const key = `${binding.telegram_user_id}\u0000${binding.telegram_chat_id}`;
      actors.set(key, { telegramUserId: binding.telegram_user_id, chatId: binding.telegram_chat_id });
    }
    return [...actors.values()];
  }

  async #setBotCommandMenus(transport: ReturnType<TransportFactory>, botId: string): Promise<void> {
    await transport.setCommands({ commands: SYSTEM_COMMANDS });
    for (const actor of this.#boundActors(botId)) {
      const commands = this.#commandsForActor(botId, actor.telegramUserId, actor.chatId);
      try {
        await transport.setCommands({ chatId: actor.chatId, commands });
      } catch {
        try { this.#queueCommandMenu(botId, commands, actor.chatId); } catch { /* A later catalog or binding sync will retry. */ }
      }
    }
  }

  #queueCommandMenu(botId: string, commands: readonly TelegramCommand[], chatId?: string): void {
    this.#repository.enqueueDelivery({
      id: randomUUID(),
      botId,
      chatId: chatId ?? "",
      payload: { method: "setMyCommands", commands },
      idempotencyKey: `${botId}:commands:${chatId ?? "default"}:${randomUUID()}`,
      now: new Date(),
    });
  }

  #queueBotCommandMenus(botId: string): void {
    this.#queueCommandMenu(botId, SYSTEM_COMMANDS);
    for (const actor of this.#boundActors(botId)) {
      this.#queueCommandMenu(botId, this.#commandsForActor(botId, actor.telegramUserId, actor.chatId), actor.chatId);
    }
  }

  #serviceCredentials(): readonly ServiceCredential[] {
    const result: ServiceCredential[] = [];
    try {
      for (const entry of fs.readdirSync(this.#config.clientsDirectory, { withFileTypes: true })) {
        const match = /^([a-z][a-z0-9-]{1,47})\.token$/.exec(entry.name);
        if (entry.isFile() && match?.[1] !== undefined) {
          const connection = this.#repository.getConnectionByService(match[1]);
          result.push({
            serviceId: match[1],
            tokenPath: path.join(this.#config.clientsDirectory, entry.name),
            ...(connection === undefined ? {} : { connection }),
          });
        }
      }
    } catch {
      // A legacy connection can still authenticate while the shared client directory is being deployed.
    }
    for (const connection of this.#repository.listConnections()) {
      if (!result.some((candidate) => candidate.serviceId === connection.serviceId && candidate.tokenPath === connection.serviceTokenPath)) {
        result.push({ serviceId: connection.serviceId, tokenPath: connection.serviceTokenPath, connection });
      }
    }
    return result;
  }

  authenticateService(authorization: string): ServiceCredential {
    const supplied = authorization.replace(/^Bearer\s+/i, "");
    if (!supplied) throw new GryphonError("service_authentication_failed", 401);
    let match: ServiceCredential | undefined;
    let readable = false;
    for (const current of this.#serviceCredentials()) {
      try {
        const expected = readSecret(current.tokenPath);
        readable = true;
        if (secretEqual(supplied, expected)) {
          if (match !== undefined && match.serviceId !== current.serviceId) throw new GryphonError("ambiguous_service_token", 409);
          match = current;
        }
      } catch (error) {
        if (error instanceof GryphonError && error.code === "ambiguous_service_token") throw error;
      }
    }
    if (match !== undefined) return match;
    if (!readable) throw new GryphonError("service_credentials_unavailable", 503);
    throw new GryphonError("service_authentication_failed", 401);
  }

  serviceBots(authorization: string): Readonly<Record<string, unknown>> {
    const target = this.authenticateService(authorization);
    return {
      schema: "exocortex.gryphon.service-bots.v1",
      serviceId: target.serviceId,
      bots: this.#repository.listBots().map((current) => ({
        id: current.id,
        alias: current.alias,
        username: current.username,
        state: current.state,
        selected: target.connection?.botId === current.id,
      })),
    };
  }

  connectService(authorization: string, input: { readonly botId: string; readonly commandPrefix: string; readonly adapterUrl: string }): Readonly<Record<string, unknown>> {
    const target = this.authenticateService(authorization);
    if (target.connection !== undefined) throw new GryphonError("service_already_connected", 409);
    const expectedPrefix = target.serviceId.replace(/-/g, "_");
    if (!COMMAND_PREFIX.test(input.commandPrefix) || input.commandPrefix !== expectedPrefix) throw new GryphonError("invalid_command_prefix");
    const bot = this.#repository.getBotById(input.botId);
    if (bot === undefined) throw new GryphonError("bot_not_found", 404);
    if (bot.state !== "ready") throw new GryphonError("bot_not_ready", 409);
    let adapter: URL;
    try { adapter = new URL(input.adapterUrl); } catch { throw new GryphonError("invalid_adapter_url"); }
    const serviceHost = this.#config.kernelOrigin ? adapter.protocol === "https:" : adapter.hostname === target.serviceId || adapter.hostname.startsWith(`${target.serviceId}.`);
    if (!(["http:", "https:"].includes(adapter.protocol)) || !serviceHost || adapter.username || adapter.password || adapter.hash || adapter.search) throw new GryphonError("invalid_adapter_url");
    try {
      this.#repository.createConnection({
        serviceId: target.serviceId,
        botId: bot.id,
        commandPrefix: input.commandPrefix,
        adapterUrl: adapter.toString(),
        serviceTokenPath: target.tokenPath,
      }, new Date());
    } catch {
      throw new GryphonError("connection_conflict", 409);
    }
    this.#queueBotCommandMenus(bot.id);
    return this.serviceStatus(authorization);
  }

  disconnectService(authorization: string): { readonly disconnected: boolean } {
    const target = this.authenticateService(authorization);
    const connection = target.connection;
    if (connection === undefined) return { disconnected: false };
    const binding = this.#repository.getBinding(connection.id);
    const removeKeyboard = binding !== undefined && this.#repository.hasReplyKeyboardRoutes(
      connection.id, binding.telegram_user_id, binding.telegram_chat_id, new Date(),
    );
    const disconnected = this.#repository.deleteConnection(target.serviceId);
    if (disconnected && binding !== undefined && removeKeyboard) {
      this.#queueMessage(connection.botId, binding.telegram_chat_id, `${connection.serviceId} disconnected.`,
        `${connection.id}:disconnect:${randomUUID()}`, { remove_keyboard: true });
    }
    if (disconnected) this.#queueBotCommandMenus(connection.botId);
    return { disconnected };
  }

  syncServiceCommandCatalog(authorization: string, value: unknown): Readonly<Record<string, unknown>> {
    const target = this.authenticateService(authorization);
    const connection = target.connection;
    if (connection === undefined) throw new GryphonError("connection_not_found", 404);
    const catalog = record(value);
    if (catalog?.schema !== "exocortex.telegram.command-catalog.v1" || !Array.isArray(catalog.commands)) {
      throw new GryphonError("invalid_command_catalog");
    }
    const commands: CommandCatalogEntry[] = [];
    const names = new Set<string>();
    for (const raw of catalog.commands) {
      const item = record(raw);
      const description = typeof item?.description === "string" ? item.description.trim().replace(/\s+/g, " ") : "";
      if (item === undefined || typeof item.name !== "string" || !COMMAND_NAME.test(item.name)
        || typeof item.adapterCommand !== "string" || !COMMAND_NAME.test(item.adapterCommand)
        || description.length < 1 || description.length > 256) {
        throw new GryphonError("invalid_command_catalog");
      }
      if (RESERVED_COMMANDS.has(item.name)) throw new GryphonError("command_conflict", 409);
      if (names.has(item.name)) throw new GryphonError("command_conflict", 409);
      names.add(item.name);
      commands.push({ name: item.name, adapterCommand: item.adapterCommand, description });
    }
    if (this.#repository.countCommandsForBotExcluding(connection.botId, connection.id) + commands.length + SYSTEM_COMMANDS.length > MAX_TELEGRAM_COMMANDS) {
      throw new GryphonError("command_limit_exceeded", 409);
    }
    let stored;
    try {
      stored = this.#repository.replaceConnectionCommands(connection.id, connection.botId, commands);
    } catch (error) {
      if (error instanceof CommandConflictError) throw new GryphonError("command_conflict", 409);
      throw error;
    }
    this.#queueBotCommandMenus(connection.botId);
    return {
      schema: "exocortex.telegram.command-catalog.v1",
      serviceId: connection.serviceId,
      commands: stored.map((item) => ({ name: item.name, adapterCommand: item.adapterCommand, description: item.description })),
    };
  }

  serviceStatus(authorization: string): Readonly<Record<string, unknown>> {
    const target = this.authenticateService(authorization);
    const connection = target.connection;
    const current = connection === undefined ? undefined : this.#repository.getBotById(connection.botId);
    if (connection !== undefined && current === undefined) throw new GryphonError("bot_not_found", 404);
    const binding = connection === undefined ? undefined : this.#repository.getBinding(connection.id);
    return {
      schema: "exocortex.gryphon.service-status.v1",
      version: this.#config.version,
      serviceId: target.serviceId,
      state: connection?.state ?? "unlinked",
      connected: connection !== undefined,
      commandPrefix: connection?.commandPrefix ?? null,
      commands: connection === undefined ? [] : this.#repository.listConnectionCommands(connection.id).map((item) => ({
        name: item.name,
        adapterCommand: item.adapterCommand,
        description: item.description,
      })),
      bot: current === undefined ? null : {
        id: current.id,
        alias: current.alias,
        username: current.username,
        state: current.state,
      },
      binding: binding === undefined ? null : { linkedAt: binding.linked_at },
    };
  }

  issueServiceLink(authorization: string): ReturnType<GryphonGateway["issueLink"]> {
    const target = this.authenticateService(authorization);
    return this.issueLink(target.serviceId);
  }

  revokeServiceLink(authorization: string): Promise<{ readonly revoked: boolean }> {
    const target = this.authenticateService(authorization);
    return this.revokeLink(target.serviceId);
  }

  issueLink(serviceId: string, now = new Date()): { readonly code: string; readonly expiresAt: string; readonly command: string; readonly botUsername?: string } {
    const target = this.#repository.getConnectionByService(serviceId);
    if (target === undefined || target.state !== "enabled") throw new GryphonError("connection_not_found", 404);
    const current = this.#repository.getBotById(target.botId);
    if (current === undefined || current.state !== "ready") throw new GryphonError("bot_not_ready", 409);
    if (this.#repository.getBinding(target.id) !== undefined) throw new GryphonError("connection_already_linked", 409);
    let code = "";
    for (let index = 0; index < 8; index += 1) code += LINK_ALPHABET[randomBytes(1)[0]! % LINK_ALPHABET.length];
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    this.#repository.createChallenge(target.id, this.#linkDigest(current.telegramBotId, code), now, expiresAt);
    return { code, expiresAt: expiresAt.toISOString(), command: `/link ${code}`, ...(current.username === undefined ? {} : { botUsername: current.username }) };
  }

  async revokeLink(serviceId: string): Promise<{ readonly revoked: boolean }> {
    const target = this.#repository.getConnectionByService(serviceId);
    if (target === undefined) throw new GryphonError("connection_not_found", 404);
    const binding = this.#repository.getBinding(target.id);
    if (binding === undefined) return { revoked: false };
    const removeKeyboard = this.#repository.hasReplyKeyboardRoutes(
      target.id, binding.telegram_user_id, binding.telegram_chat_id, new Date(),
    );
    await this.#adapterDispatcher(target, readSecret(target.serviceTokenPath), {
      schema: "exocortex.telegram.command.v1",
      eventId: `binding-revoked:${target.id}:${randomUUID()}`,
      correlationId: randomUUID(),
      connectionId: target.id,
      serviceId: target.serviceId,
      actor: {
        telegramUserId: binding.telegram_user_id,
        chatId: binding.telegram_chat_id,
        chatType: "private",
      },
      command: "binding_revoked",
      arguments: {},
    });
    const revoked = this.#repository.revokeBinding(target.id);
    if (revoked && removeKeyboard) {
      this.#queueMessage(target.botId, binding.telegram_chat_id, `${target.serviceId} unlinked.`,
        `${target.id}:unlink:${randomUUID()}`, { remove_keyboard: true });
    }
    if (revoked) this.#queueBotCommandMenus(target.botId);
    return { revoked };
  }

  #linkDigest(telegramBotId: string, code: string): string {
    return createHmac("sha256", this.#pepper).update(`${telegramBotId}:${code.toUpperCase()}`, "utf8").digest("hex");
  }

  acceptUpdate(webhookKey: string, secret: string, body: unknown, now = new Date()): { readonly accepted: boolean } {
    const current = this.#repository.getBotByWebhookKey(webhookKey);
    if (current === undefined) throw new GryphonError("webhook_not_found", 404);
    if (!secret || !secretEqual(secret, current.webhookSecret)) throw new GryphonError("webhook_authentication_failed", 401);
    const updateId = record(body)?.update_id;
    if (typeof updateId !== "number" || !Number.isSafeInteger(updateId)) throw new GryphonError("invalid_telegram_update");
    const accepted = this.#repository.acceptUpdate(current.id, String(updateId), body, now);
    return { accepted };
  }

  async drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const pending = this.#repository.claimUpdate(new Date());
        if (pending === undefined) break;
        try {
          await this.#processUpdate(pending.botId, pending.updateId, pending.body);
          this.#repository.completeUpdate(pending.botId, pending.updateId, new Date());
        } catch (error) {
          this.#repository.failUpdate(pending.botId, pending.updateId, sanitizedError(error), retryAt(pending.attempts));
        }
      }
      for (;;) {
        const delivery = this.#repository.claimDelivery(new Date());
        if (delivery === undefined) break;
        try {
          const current = this.#repository.getBotById(delivery.botId);
          if (current === undefined || current.state !== "ready") throw new GryphonError("bot_not_ready", 503);
          const transport = this.#transportFactory(readSecret(current.tokenPath));
          const method = delivery.payload.method;
          if (method === "sendMessage") {
            const text = delivery.payload.text;
            if (typeof text !== "string") throw new GryphonError("invalid_delivery");
            await transport.sendMessage({
              chatId: delivery.chatId,
              text,
              ...(record(delivery.payload.replyMarkup) === undefined ? {} : { replyMarkup: record(delivery.payload.replyMarkup)! }),
            });
          } else if (method === "answerCallbackQuery") {
            const callbackQueryId = delivery.payload.callbackQueryId;
            if (typeof callbackQueryId !== "string") throw new GryphonError("invalid_delivery");
            await transport.answerCallbackQuery({
              callbackQueryId,
              ...(typeof delivery.payload.text === "string" ? { text: delivery.payload.text } : {}),
              ...(typeof delivery.payload.showAlert === "boolean" ? { showAlert: delivery.payload.showAlert } : {}),
            });
          } else if (method === "setMyCommands") {
            await transport.setCommands({
              ...(delivery.chatId ? { chatId: delivery.chatId } : {}),
              commands: telegramCommands(delivery.payload.commands),
            });
          } else {
            throw new GryphonError("invalid_delivery");
          }
          this.#repository.completeDelivery(delivery.id, new Date());
        } catch (error) {
          this.#repository.failDelivery(delivery.id, sanitizedError(error), retryAt(delivery.attempts));
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #processUpdate(botId: string, updateId: string, body: unknown): Promise<void> {
    const message = rawMessage(body);
    if (message !== undefined) {
      if (message.userId === undefined || message.isBot || message.chatType !== "private" || message.text === undefined) return;
      const actor: TelegramActor = {
        telegramUserId: message.userId,
        chatId: message.chatId,
        chatType: message.chatType,
        ...(message.displayName === undefined ? {} : { displayName: message.displayName }),
      };
      await this.#processMessage(botId, updateId, actor, message.text);
      return;
    }
    const callback = rawCallback(body);
    if (callback === undefined || callback.isBot || callback.chatType !== "private" || callback.data === undefined) return;
    const target = this.#repository.getCallback({ token: callback.data, telegramUserId: callback.userId, chatId: callback.chatId, now: new Date() });
    if (target === undefined) {
      this.#queueCallback(botId, callback.chatId, callback.id, "This action has expired.", true, `${botId}:${updateId}:callback-expired`);
      return;
    }
    const binding = this.#repository.getBinding(target.connection.id);
    if (binding?.telegram_user_id !== callback.userId || binding.telegram_chat_id !== callback.chatId) {
      this.#queueCallback(botId, callback.chatId, callback.id, "This action is not authorized.", true, `${botId}:${updateId}:callback-denied`);
      return;
    }
    const actor: TelegramActor = {
      telegramUserId: callback.userId,
      chatId: callback.chatId,
      chatType: callback.chatType,
      ...(callback.displayName === undefined ? {} : { displayName: callback.displayName }),
    };
    await this.#dispatch(botId, updateId, target.connection, actor, target.command, target.arguments);
    this.#repository.consumeCallback(callback.data, new Date());
    this.#queueCallback(botId, callback.chatId, callback.id, "Done", false, `${botId}:${updateId}:callback-ok`);
  }

  #queueHelp(botId: string, updateId: string, actor: TelegramActor, start: boolean): void {
    const heading = start ? "Gryphon is ready.\n\nAvailable commands:" : "Available commands:";
    const lines = this.#commandsForActor(botId, actor.telegramUserId, actor.chatId)
      .map((item) => `/${item.command} — ${item.description}`);
    const chunks: string[] = [];
    let current = heading;
    for (const line of lines) {
      if (`${current}\n${line}`.length > 4_096) {
        chunks.push(current);
        current = line;
      } else {
        current += `\n${line}`;
      }
    }
    chunks.push(current);
    chunks.forEach((chunk, index) => this.#queueMessage(botId, actor.chatId, chunk, `${botId}:${updateId}:help:${String(index)}`));
  }

  async #processMessage(botId: string, updateId: string, actor: TelegramActor, text: string): Promise<void> {
    const trimmed = text.trim();
    const [head = "", ...tail] = trimmed.split(/\s+/);
    const normalizedHead = head.toLowerCase().split("@")[0]!;
    const slashCommand = normalizedHead.startsWith("/");
    const cancelledPending = slashCommand
      ? this.#repository.clearPendingInput(botId, actor.telegramUserId, actor.chatId)
      : false;

    if (normalizedHead === "/cancel") {
      this.#queueMessage(botId, actor.chatId, cancelledPending ? "Pending input cancelled." : "There is no pending input.", `${botId}:${updateId}:cancel`);
      return;
    }
    if (normalizedHead === "/link") {
      const code = (tail[0] ?? "").toUpperCase();
      const current = this.#repository.getBotById(botId)!;
      const target = /^[A-HJ-NP-Z2-9]{8}$/.test(code)
        ? this.#repository.consumeChallenge({ botId, digest: this.#linkDigest(current.telegramBotId, code), telegramUserId: actor.telegramUserId, chatId: actor.chatId, now: new Date() })
        : undefined;
      this.#queueMessage(botId, actor.chatId, target === undefined ? "The link code is invalid or has expired." : `${target.serviceId} linked to this Telegram account.`, `${botId}:${updateId}:link`);
      if (target !== undefined) {
        this.#queueCommandMenu(botId, this.#commandsForActor(botId, actor.telegramUserId, actor.chatId), actor.chatId);
        const initialCommand = this.#repository.listConnectionCommands(target.id).some((item) => item.adapterCommand === "menu") ? "menu" : "start";
        try { await this.#dispatch(botId, updateId, target, actor, initialCommand, {}); } catch { /* Linking remains valid while a service restarts. */ }
      }
      return;
    }
    if (normalizedHead === "/start" || normalizedHead === "/help") {
      this.#queueHelp(botId, updateId, actor, normalizedHead === "/start");
      return;
    }
    if (normalizedHead === "/services" || normalizedHead === "/status") {
      const lines = this.#repository.listConnectionsForBot(botId).map((item) => {
        const binding = this.#repository.getBinding(item.id);
        const linked = binding?.telegram_user_id === actor.telegramUserId && binding.telegram_chat_id === actor.chatId;
        return `${item.serviceId}: ${linked ? "linked" : "not linked"}`;
      });
      this.#queueMessage(botId, actor.chatId, lines.length ? lines.join("\n") : "No services are connected.", `${botId}:${updateId}:services`);
      return;
    }

    if (!slashCommand) {
      const pending = this.#repository.getPendingInput({ botId, telegramUserId: actor.telegramUserId, chatId: actor.chatId, now: new Date() });
      if (pending !== undefined) {
        const binding = this.#repository.getBinding(pending.connection.id);
        if (binding?.telegram_user_id === actor.telegramUserId && binding.telegram_chat_id === actor.chatId) {
          await this.#dispatch(botId, updateId, pending.connection, actor, pending.adapterCommand, { text: trimmed }, true);
          return;
        }
        this.#repository.clearPendingInput(botId, actor.telegramUserId, actor.chatId);
      }
      const keyboard = this.#repository.getReplyKeyboardRoute({
        botId,
        telegramUserId: actor.telegramUserId,
        chatId: actor.chatId,
        buttonText: trimmed,
        now: new Date(),
      });
      if (keyboard !== undefined) {
        const binding = this.#repository.getBinding(keyboard.connection.id);
        if (binding?.telegram_user_id === actor.telegramUserId && binding.telegram_chat_id === actor.chatId) {
          await this.#dispatch(botId, updateId, keyboard.connection, actor, keyboard.command, keyboard.arguments);
          return;
        }
      }
      this.#queueMessage(botId, actor.chatId, "Use /help to see the available commands.", `${botId}:${updateId}:unknown`);
      return;
    }

    const commandName = normalizedHead.slice(1);
    const registered = this.#repository.getConnectionCommand(botId, commandName);
    if (registered !== undefined) {
      const target = this.#repository.getConnectionById(registered.connectionId)!;
      const binding = this.#repository.getBinding(target.id);
      if (binding?.telegram_user_id !== actor.telegramUserId || binding.telegram_chat_id !== actor.chatId) {
        this.#queueMessage(botId, actor.chatId, `${target.serviceId} is not linked to this Telegram account.`, `${botId}:${updateId}:denied`);
        return;
      }
      await this.#dispatch(botId, updateId, target, actor, registered.adapterCommand, { text: tail.join(" ") });
      return;
    }

    let prefix = commandName;
    let command = tail.shift()?.toLowerCase() ?? "start";
    const underscore = commandName.indexOf("_");
    if (underscore > 0) {
      prefix = commandName.slice(0, underscore);
      command = commandName.slice(underscore + 1);
    }
    const target = this.#repository.getConnectionByPrefix(botId, prefix);
    if (target === undefined) {
      this.#queueMessage(botId, actor.chatId, "Unknown command. Use /help.", `${botId}:${updateId}:unknown-service`);
      return;
    }
    const binding = this.#repository.getBinding(target.id);
    if (binding?.telegram_user_id !== actor.telegramUserId || binding.telegram_chat_id !== actor.chatId) {
      this.#queueMessage(botId, actor.chatId, `${target.serviceId} is not linked to this Telegram account.`, `${botId}:${updateId}:denied`);
      return;
    }
    await this.#dispatch(botId, updateId, target, actor, command, { text: tail.join(" ") });
  }

  async #dispatch(botId: string, updateId: string, target: ConnectionRecord, actor: TelegramActor, command: string, argumentsValue: Readonly<Record<string, unknown>>, clearPendingAfterResponse = false): Promise<void> {
    if (!COMMAND_NAME.test(command)) throw new GryphonError("invalid_command");
    const correlationId = randomUUID();
    const envelope: CommandEnvelope = {
      schema: "exocortex.telegram.command.v1",
      eventId: `${botId}:${updateId}`,
      correlationId,
      connectionId: target.id,
      serviceId: target.serviceId,
      actor,
      command,
      arguments: argumentsValue,
    };
    const result = await this.#adapterDispatcher(target, readSecret(target.serviceTokenPath), envelope);
    let index = 0;
    for (const current of result.actions) {
      await this.#queueAction(botId, target, actor, current, `${botId}:${updateId}:action:${String(index)}`);
      index += 1;
    }
    if (clearPendingAfterResponse && !result.actions.some((current) => current.expectInput !== undefined)) {
      this.#repository.clearPendingInput(botId, actor.telegramUserId, actor.chatId);
    }
  }

  async #queueAction(botId: string, target: ConnectionRecord, actor: TelegramActor, current: ResponseAction, idempotencyKey: string): Promise<void> {
    let replyMarkup: Readonly<Record<string, unknown>> | undefined;
    if (current.buttons !== undefined) {
      const keyboard = current.buttons.map((row) => row.map((button) => {
        const token = randomBytes(18).toString("base64url");
        this.#repository.createCallback({
          token,
          connectionId: target.id,
          telegramUserId: actor.telegramUserId,
          chatId: actor.chatId,
          command: button.command,
          arguments: button.arguments ?? {},
          expiresAt: new Date(Date.now() + 15 * 60_000),
        });
        return { text: button.text, callback_data: token };
      }));
      replyMarkup = { inline_keyboard: keyboard };
    } else if (current.replyKeyboard !== undefined) {
      try {
        this.#repository.replaceReplyKeyboardRoutes({
          botId,
          connectionId: target.id,
          telegramUserId: actor.telegramUserId,
          chatId: actor.chatId,
          rows: current.replyKeyboard.rows.map((row) => row.map((button) => ({
            text: button.text,
            command: button.command,
            arguments: button.arguments ?? {},
          }))),
          expiresAt: new Date(Date.now() + 10 * 365 * 86_400_000),
        });
      } catch (error) {
        if (error instanceof ReplyKeyboardConflictError) throw new GryphonError("reply_keyboard_conflict", 502);
        throw error;
      }
      replyMarkup = {
        keyboard: current.replyKeyboard.rows.map((row) => row.map((button) => ({ text: button.text }))),
        is_persistent: true,
        resize_keyboard: current.replyKeyboard.resize,
        ...(current.replyKeyboard.placeholder === undefined ? {} : { input_field_placeholder: current.replyKeyboard.placeholder }),
      };
    }
    if (current.expectInput !== undefined) {
      this.#repository.setPendingInput({
        botId,
        connectionId: target.id,
        telegramUserId: actor.telegramUserId,
        chatId: actor.chatId,
        adapterCommand: current.expectInput.command,
        expiresAt: new Date(Date.now() + current.expectInput.expiresInSeconds * 1_000),
      });
    }
    this.#queueMessage(botId, actor.chatId, current.text, idempotencyKey, replyMarkup);
  }

  #queueMessage(botId: string, chatId: string, text: string, idempotencyKey: string, replyMarkup?: Readonly<Record<string, unknown>>): void {
    this.#repository.enqueueDelivery({
      id: randomUUID(), botId, chatId, idempotencyKey, now: new Date(),
      payload: { method: "sendMessage", text, ...(replyMarkup === undefined ? {} : { replyMarkup }) },
    });
  }

  #queueCallback(botId: string, chatId: string, callbackQueryId: string, text: string, showAlert: boolean, idempotencyKey: string): void {
    this.#repository.enqueueDelivery({
      id: randomUUID(), botId, chatId, idempotencyKey, now: new Date(),
      payload: { method: "answerCallbackQuery", callbackQueryId, text, showAlert },
    });
  }

  notify(serviceId: string, authorization: string, input: { readonly text: string; readonly idempotencyKey: string }): { readonly accepted: boolean } {
    const target = this.#repository.getConnectionByService(serviceId);
    if (target === undefined || target.state !== "enabled") throw new GryphonError("connection_not_found", 404);
    const identity = this.authenticateService(authorization);
    if (identity.serviceId !== serviceId || identity.connection?.id !== target.id) throw new GryphonError("service_authentication_failed", 401);
    if (input.text.length < 1 || input.text.length > 4_096 || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) throw new GryphonError("invalid_notification");
    const binding = this.#repository.getBinding(target.id);
    if (binding === undefined) throw new GryphonError("connection_not_linked", 409);
    return {
      accepted: this.#repository.enqueueDelivery({
        id: randomUUID(), botId: target.botId, chatId: binding.telegram_chat_id,
        payload: { method: "sendMessage", text: input.text },
        idempotencyKey: `${target.id}:notification:${input.idempotencyKey}`, now: new Date(),
      }),
    };
  }

  notifyService(authorization: string, input: { readonly text: string; readonly idempotencyKey: string }): { readonly accepted: boolean } {
    const target = this.authenticateService(authorization);
    if (target.connection === undefined) throw new GryphonError("connection_not_found", 404);
    return this.notify(target.serviceId, authorization, input);
  }
}

export function loadOrCreatePepper(dataDirectory: string): Buffer {
  const filename = path.join(dataDirectory, "secrets", "link-code.pepper");
  if (!fs.existsSync(filename)) writeSecret(filename, randomBytes(32).toString("base64url"));
  const value = readSecret(filename);
  if (value.length < 32) throw new Error("Gryphon link-code pepper is invalid");
  return Buffer.from(value, "utf8");
}

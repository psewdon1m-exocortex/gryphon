import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotRecord, CommandCatalogEntry, ConnectionCommandRecord, ConnectionRecord } from "./types.js";

export class RepositoryCapacityError extends Error {
  constructor() { super("queue_capacity_exceeded"); }
}

export class CommandConflictError extends Error {
  constructor(readonly commandName: string) { super("command_conflict"); }
}

export class ReplyKeyboardConflictError extends Error {
  constructor(readonly buttonText: string) { super("reply_keyboard_conflict"); }
}

interface BotRow {
  readonly id: string;
  readonly telegram_bot_id: string;
  readonly alias: string;
  readonly username: string | null;
  readonly token_path: string;
  readonly token_fingerprint: string;
  readonly webhook_key: string;
  readonly webhook_secret: string;
  readonly state: BotRecord["state"];
}

interface ConnectionRow {
  readonly id: string;
  readonly service_id: string;
  readonly bot_id: string;
  readonly command_prefix: string;
  readonly adapter_url: string;
  readonly service_token_path: string;
  readonly state: ConnectionRecord["state"];
}

export interface BindingRecord {
  readonly connection_id: string;
  readonly telegram_user_id: string;
  readonly telegram_chat_id: string;
  readonly linked_at: string;
}

interface CommandRow {
  readonly connection_id: string;
  readonly bot_id: string;
  readonly service_id: string;
  readonly command_name: string;
  readonly adapter_command: string;
  readonly description: string;
}

export interface PendingInputRecord {
  readonly botId: string;
  readonly connection: ConnectionRecord;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly adapterCommand: string;
  readonly expiresAt: string;
}

export interface PendingUpdate {
  readonly botId: string;
  readonly updateId: string;
  readonly body: unknown;
  readonly attempts: number;
}

export interface PendingDelivery {
  readonly id: string;
  readonly botId: string;
  readonly chatId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}

function bot(row: BotRow): BotRecord {
  return {
    id: row.id,
    telegramBotId: row.telegram_bot_id,
    alias: row.alias,
    ...(row.username === null ? {} : { username: row.username }),
    tokenPath: row.token_path,
    tokenFingerprint: row.token_fingerprint,
    webhookKey: row.webhook_key,
    webhookSecret: row.webhook_secret,
    state: row.state,
  };
}

function connection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    serviceId: row.service_id,
    botId: row.bot_id,
    commandPrefix: row.command_prefix,
    adapterUrl: row.adapter_url,
    serviceTokenPath: row.service_token_path,
    state: row.state,
  };
}

function command(row: CommandRow): ConnectionCommandRecord {
  return {
    connectionId: row.connection_id,
    botId: row.bot_id,
    serviceId: row.service_id,
    name: row.command_name,
    adapterCommand: row.adapter_command,
    description: row.description,
  };
}

export class GryphonRepository {
  readonly #database: DatabaseSync;
  readonly #limits: { readonly records: number; readonly bytes: number };

  constructor(filename: string, limits = { records: 100_000, bytes: 64 * 1024 * 1024 }) {
    if (!Number.isSafeInteger(limits.records) || limits.records < 1 || limits.records > 100_000 || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 64 * 1024 * 1024)
      throw new Error("Invalid repository retention limits");
    this.#limits = limits;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        telegram_bot_id TEXT NOT NULL UNIQUE,
        alias TEXT NOT NULL UNIQUE,
        username TEXT,
        token_path TEXT NOT NULL,
        token_fingerprint TEXT NOT NULL,
        webhook_key TEXT NOT NULL UNIQUE,
        webhook_secret TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('starting','ready','degraded','disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL REFERENCES bots(id),
        command_prefix TEXT NOT NULL,
        adapter_url TEXT NOT NULL,
        service_token_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('enabled','disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, command_prefix)
      );
      CREATE TABLE IF NOT EXISTS telegram_bindings (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        linked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_commands (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        command_name TEXT NOT NULL,
        adapter_command TEXT NOT NULL,
        description TEXT NOT NULL,
        PRIMARY KEY (connection_id, command_name),
        UNIQUE (bot_id, command_name)
      );
      CREATE INDEX IF NOT EXISTS connection_commands_connection ON connection_commands(connection_id, command_name);
      CREATE TABLE IF NOT EXISTS reply_keyboard_routes (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        button_text TEXT NOT NULL,
        adapter_command TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        column_index INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, telegram_user_id, telegram_chat_id, button_text)
      );
      CREATE INDEX IF NOT EXISTS reply_keyboard_routes_connection ON reply_keyboard_routes(connection_id, telegram_user_id, telegram_chat_id);
      CREATE TABLE IF NOT EXISTS pending_inputs (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        adapter_command TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, telegram_user_id, telegram_chat_id)
      );
      CREATE INDEX IF NOT EXISTS pending_inputs_connection ON pending_inputs(connection_id);
      CREATE TABLE IF NOT EXISTS link_challenges (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        code_digest TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS link_challenges_active ON link_challenges(connection_id, expires_at) WHERE consumed_at IS NULL;
      CREATE TABLE IF NOT EXISTS telegram_updates (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        update_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','processing','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        received_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (bot_id, update_id)
      );
      CREATE TABLE IF NOT EXISTS callbacks (
        token TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        command TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('queued','processing','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    this.#database.exec("UPDATE telegram_updates SET state='queued' WHERE state='processing'; UPDATE delivery_outbox SET state='queued' WHERE state='processing';");
    this.#database.exec(`CREATE TABLE IF NOT EXISTS queue_sizes (name TEXT PRIMARY KEY, records INTEGER NOT NULL, bytes INTEGER NOT NULL);`);
    for (const [table, payload] of [["telegram_updates", "body_json"], ["delivery_outbox", "payload_json"], ["callbacks", "arguments_json"]] as const) {
      this.#database.exec(`
        INSERT OR REPLACE INTO queue_sizes SELECT '${table}',count(*),coalesce(sum(length(CAST(${payload} AS BLOB))),0) FROM ${table};
        CREATE TRIGGER IF NOT EXISTS ${table}_size_insert AFTER INSERT ON ${table} BEGIN
          UPDATE queue_sizes SET records=records+1,bytes=bytes+length(CAST(NEW.${payload} AS BLOB)) WHERE name='${table}'; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_size_update AFTER UPDATE OF ${payload} ON ${table} BEGIN
          UPDATE queue_sizes SET bytes=bytes+length(CAST(NEW.${payload} AS BLOB))-length(CAST(OLD.${payload} AS BLOB)) WHERE name='${table}'; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_size_delete AFTER DELETE ON ${table} BEGIN
          UPDATE queue_sizes SET records=records-1,bytes=bytes-length(CAST(OLD.${payload} AS BLOB)) WHERE name='${table}'; END;
      `);
    }
    this.maintain(new Date());
    fs.chmodSync(filename, 0o600);
  }

  close(): void { this.#database.close(); }

  /** Retain deduplication tombstones for 30 days; capacity never evicts a live tombstone or pending job. */
  maintain(now: Date): void {
    const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    this.transaction(() => {
      this.#database.prepare("DELETE FROM telegram_updates WHERE state='completed' AND completed_at<?").run(cutoff);
      this.#database.prepare("DELETE FROM delivery_outbox WHERE state='completed' AND completed_at<?").run(cutoff);
      this.#database.prepare("DELETE FROM callbacks WHERE expires_at<=? OR consumed_at IS NOT NULL").run(now.toISOString());
      this.#database.prepare("DELETE FROM link_challenges WHERE expires_at<=? OR consumed_at IS NOT NULL").run(now.toISOString());
      this.#database.prepare("DELETE FROM reply_keyboard_routes WHERE expires_at<=?").run(now.toISOString());
      this.#database.prepare("DELETE FROM pending_inputs WHERE expires_at<=?").run(now.toISOString());
      this.#database.exec("UPDATE telegram_updates SET body_json='{}' WHERE state='completed' AND body_json<>'{}'; UPDATE delivery_outbox SET payload_json='{}' WHERE state='completed' AND payload_json<>'{}';");
    });
    this.#database.exec("PRAGMA wal_checkpoint(PASSIVE);");
  }

  #requireCapacity(table: "telegram_updates" | "delivery_outbox" | "callbacks", json: string): void {
    const bytes = Buffer.byteLength(json);
    const size = this.#database.prepare("SELECT records,bytes FROM queue_sizes WHERE name=?").get(table) as { records: number; bytes: number };
    if (bytes > 65_536 || size.records >= Math.min(table === "callbacks" ? 10_000 : 100_000, this.#limits.records) || size.bytes + bytes > this.#limits.bytes)
      throw new RepositoryCapacityError();
  }

  transaction<T>(work: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listBots(): readonly BotRecord[] {
    return (this.#database.prepare("SELECT * FROM bots ORDER BY alias").all() as unknown as BotRow[]).map(bot);
  }

  getBotById(id: string): BotRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM bots WHERE id=?").get(id) as unknown as BotRow | undefined;
    return row === undefined ? undefined : bot(row);
  }

  getBotByTelegramId(id: string): BotRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM bots WHERE telegram_bot_id=?").get(id) as unknown as BotRow | undefined;
    return row === undefined ? undefined : bot(row);
  }

  getBotByWebhookKey(key: string): BotRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM bots WHERE webhook_key=?").get(key) as unknown as BotRow | undefined;
    return row === undefined ? undefined : bot(row);
  }

  createBot(input: Omit<BotRecord, "id" | "state">, now: Date): BotRecord {
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.#database.prepare(`INSERT INTO bots
      (id,telegram_bot_id,alias,username,token_path,token_fingerprint,webhook_key,webhook_secret,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.telegramBotId, input.alias, input.username ?? null, input.tokenPath,
        input.tokenFingerprint, input.webhookKey, input.webhookSecret, "starting", timestamp, timestamp,
      );
    return this.getBotById(id)!;
  }

  setBotState(id: string, state: BotRecord["state"], now: Date): void {
    this.#database.prepare("UPDATE bots SET state=?, updated_at=? WHERE id=?").run(state, now.toISOString(), id);
  }

  getConnectionByService(serviceId: string): ConnectionRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM connections WHERE service_id=?").get(serviceId) as unknown as ConnectionRow | undefined;
    return row === undefined ? undefined : connection(row);
  }

  getConnectionById(id: string): ConnectionRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM connections WHERE id=?").get(id) as unknown as ConnectionRow | undefined;
    return row === undefined ? undefined : connection(row);
  }

  getConnectionByPrefix(botId: string, prefix: string): ConnectionRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM connections WHERE bot_id=? AND command_prefix=? AND state='enabled'").get(botId, prefix) as unknown as ConnectionRow | undefined;
    return row === undefined ? undefined : connection(row);
  }

  listConnections(): readonly ConnectionRecord[] {
    return (this.#database.prepare("SELECT * FROM connections ORDER BY service_id").all() as unknown as ConnectionRow[]).map(connection);
  }

  listConnectionsForBot(botId: string): readonly ConnectionRecord[] {
    return (this.#database.prepare("SELECT * FROM connections WHERE bot_id=? AND state='enabled' ORDER BY service_id").all(botId) as unknown as ConnectionRow[]).map(connection);
  }

  getConnectionCommand(botId: string, commandName: string): ConnectionCommandRecord | undefined {
    const row = this.#database.prepare(`SELECT cc.connection_id,cc.bot_id,c.service_id,cc.command_name,cc.adapter_command,cc.description
      FROM connection_commands cc JOIN connections c ON c.id=cc.connection_id
      WHERE cc.bot_id=? AND cc.command_name=? AND c.state='enabled'`).get(botId, commandName) as unknown as CommandRow | undefined;
    return row === undefined ? undefined : command(row);
  }

  listConnectionCommands(connectionId: string): readonly ConnectionCommandRecord[] {
    return (this.#database.prepare(`SELECT cc.connection_id,cc.bot_id,c.service_id,cc.command_name,cc.adapter_command,cc.description
      FROM connection_commands cc JOIN connections c ON c.id=cc.connection_id
      WHERE cc.connection_id=? ORDER BY cc.command_name`).all(connectionId) as unknown as CommandRow[]).map(command);
  }

  listCommandsForActor(botId: string, telegramUserId: string, chatId: string): readonly ConnectionCommandRecord[] {
    return (this.#database.prepare(`SELECT cc.connection_id,cc.bot_id,c.service_id,cc.command_name,cc.adapter_command,cc.description
      FROM connection_commands cc
      JOIN connections c ON c.id=cc.connection_id AND c.state='enabled'
      JOIN telegram_bindings tb ON tb.connection_id=c.id
      WHERE cc.bot_id=? AND tb.telegram_user_id=? AND tb.telegram_chat_id=?
      ORDER BY cc.command_name`).all(botId, telegramUserId, chatId) as unknown as CommandRow[]).map(command);
  }

  countCommandsForBotExcluding(botId: string, connectionId: string): number {
    const row = this.#database.prepare("SELECT count(*) AS total FROM connection_commands WHERE bot_id=? AND connection_id<>?")
      .get(botId, connectionId) as unknown as { readonly total: number };
    return row.total;
  }

  replaceConnectionCommands(connectionId: string, botId: string, entries: readonly CommandCatalogEntry[]): readonly ConnectionCommandRecord[] {
    return this.transaction(() => {
      for (const entry of entries) {
        const conflict = this.#database.prepare("SELECT connection_id FROM connection_commands WHERE bot_id=? AND command_name=? AND connection_id<>?")
          .get(botId, entry.name, connectionId) as unknown as { readonly connection_id: string } | undefined;
        if (conflict !== undefined) throw new CommandConflictError(entry.name);
      }
      this.#database.prepare("DELETE FROM connection_commands WHERE connection_id=?").run(connectionId);
      const insert = this.#database.prepare(`INSERT INTO connection_commands
        (connection_id,bot_id,command_name,adapter_command,description) VALUES (?,?,?,?,?)`);
      for (const entry of entries) insert.run(connectionId, botId, entry.name, entry.adapterCommand, entry.description);
      return this.listConnectionCommands(connectionId);
    });
  }

  createConnection(input: Omit<ConnectionRecord, "id" | "state">, now: Date): ConnectionRecord {
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.#database.prepare(`INSERT INTO connections
      (id,service_id,bot_id,command_prefix,adapter_url,service_token_path,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        id, input.serviceId, input.botId, input.commandPrefix, input.adapterUrl,
        input.serviceTokenPath, "enabled", timestamp, timestamp,
      );
    return this.getConnectionById(id)!;
  }

  deleteConnection(serviceId: string): boolean {
    return Number(this.#database.prepare("DELETE FROM connections WHERE service_id=?").run(serviceId).changes) > 0;
  }

  getBinding(connectionId: string): BindingRecord | undefined {
    return this.#database.prepare("SELECT * FROM telegram_bindings WHERE connection_id=?").get(connectionId) as unknown as BindingRecord | undefined;
  }

  listBindingsForBot(botId: string): readonly BindingRecord[] {
    return this.#database.prepare(`SELECT DISTINCT tb.connection_id,tb.telegram_user_id,tb.telegram_chat_id,tb.linked_at
      FROM telegram_bindings tb JOIN connections c ON c.id=tb.connection_id
      WHERE c.bot_id=? AND c.state='enabled' ORDER BY tb.telegram_chat_id,tb.telegram_user_id`).all(botId) as unknown as BindingRecord[];
  }

  createChallenge(connectionId: string, digest: string, now: Date, expiresAt: Date): void {
    this.transaction(() => {
      this.#database.prepare("DELETE FROM link_challenges WHERE connection_id=? AND consumed_at IS NULL").run(connectionId);
      this.#database.prepare("INSERT INTO link_challenges (id,connection_id,code_digest,created_at,expires_at) VALUES (?,?,?,?,?)")
        .run(randomUUID(), connectionId, digest, now.toISOString(), expiresAt.toISOString());
    });
  }

  consumeChallenge(input: { readonly botId: string; readonly digest: string; readonly telegramUserId: string; readonly chatId: string; readonly now: Date }): ConnectionRecord | undefined {
    return this.transaction(() => {
      const row = this.#database.prepare(`SELECT lc.id, lc.connection_id
        FROM link_challenges lc JOIN connections c ON c.id=lc.connection_id
        WHERE c.bot_id=? AND lc.code_digest=? AND lc.consumed_at IS NULL AND lc.expires_at>? AND c.state='enabled'
        LIMIT 1`).get(input.botId, input.digest, input.now.toISOString()) as unknown as { readonly id: string; readonly connection_id: string } | undefined;
      if (row === undefined || this.getBinding(row.connection_id) !== undefined) return undefined;
      this.#database.prepare("INSERT INTO telegram_bindings (connection_id,telegram_user_id,telegram_chat_id,linked_at) VALUES (?,?,?,?)")
        .run(row.connection_id, input.telegramUserId, input.chatId, input.now.toISOString());
      this.#database.prepare("UPDATE link_challenges SET consumed_at=? WHERE id=?").run(input.now.toISOString(), row.id);
      return this.getConnectionById(row.connection_id);
    });
  }

  revokeBinding(connectionId: string): boolean {
    return this.transaction(() => {
      const binding = this.getBinding(connectionId);
      this.#database.prepare("DELETE FROM link_challenges WHERE connection_id=? AND consumed_at IS NULL").run(connectionId);
      if (binding !== undefined) {
        this.#database.prepare("DELETE FROM pending_inputs WHERE connection_id=? AND telegram_user_id=? AND telegram_chat_id=?")
          .run(connectionId, binding.telegram_user_id, binding.telegram_chat_id);
        this.#database.prepare("DELETE FROM reply_keyboard_routes WHERE connection_id=? AND telegram_user_id=? AND telegram_chat_id=?")
          .run(connectionId, binding.telegram_user_id, binding.telegram_chat_id);
      }
      return Number(this.#database.prepare("DELETE FROM telegram_bindings WHERE connection_id=?").run(connectionId).changes) > 0;
    });
  }

  replaceReplyKeyboardRoutes(input: {
    readonly botId: string;
    readonly connectionId: string;
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly rows: readonly (readonly { readonly text: string; readonly command: string; readonly arguments: Readonly<Record<string, unknown>> }[])[];
    readonly expiresAt: Date;
  }): void {
    this.transaction(() => {
      for (const row of input.rows) {
        for (const button of row) {
          const conflict = this.#database.prepare(`SELECT connection_id FROM reply_keyboard_routes
            WHERE bot_id=? AND telegram_user_id=? AND telegram_chat_id=? AND button_text=? AND connection_id<>?`)
            .get(input.botId, input.telegramUserId, input.chatId, button.text, input.connectionId) as unknown as { readonly connection_id: string } | undefined;
          if (conflict !== undefined) throw new ReplyKeyboardConflictError(button.text);
        }
      }
      this.#database.prepare("DELETE FROM reply_keyboard_routes WHERE connection_id=? AND telegram_user_id=? AND telegram_chat_id=?")
        .run(input.connectionId, input.telegramUserId, input.chatId);
      const insert = this.#database.prepare(`INSERT INTO reply_keyboard_routes
        (bot_id,connection_id,telegram_user_id,telegram_chat_id,button_text,adapter_command,arguments_json,row_index,column_index,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      input.rows.forEach((row, rowIndex) => row.forEach((button, columnIndex) => {
        insert.run(input.botId, input.connectionId, input.telegramUserId, input.chatId, button.text, button.command,
          JSON.stringify(button.arguments), rowIndex, columnIndex, input.expiresAt.toISOString());
      }));
    });
  }

  hasReplyKeyboardRoutes(connectionId: string, telegramUserId: string, chatId: string, now: Date): boolean {
    return this.#database.prepare(`SELECT 1 FROM reply_keyboard_routes
      WHERE connection_id=? AND telegram_user_id=? AND telegram_chat_id=? AND expires_at>? LIMIT 1`)
      .get(connectionId, telegramUserId, chatId, now.toISOString()) !== undefined;
  }

  getReplyKeyboardRoute(input: { readonly botId: string; readonly telegramUserId: string; readonly chatId: string; readonly buttonText: string; readonly now: Date }): {
    readonly connection: ConnectionRecord;
    readonly command: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  } | undefined {
    const row = this.#database.prepare(`SELECT r.connection_id,r.adapter_command,r.arguments_json
      FROM reply_keyboard_routes r JOIN connections c ON c.id=r.connection_id
      WHERE r.bot_id=? AND r.telegram_user_id=? AND r.telegram_chat_id=? AND r.button_text=? AND r.expires_at>? AND c.state='enabled'`)
      .get(input.botId, input.telegramUserId, input.chatId, input.buttonText, input.now.toISOString()) as unknown as {
        readonly connection_id: string;
        readonly adapter_command: string;
        readonly arguments_json: string;
      } | undefined;
    if (row === undefined) return undefined;
    const target = this.getConnectionById(row.connection_id);
    if (target === undefined) return undefined;
    return { connection: target, command: row.adapter_command, arguments: JSON.parse(row.arguments_json) as Readonly<Record<string, unknown>> };
  }

  setPendingInput(input: {
    readonly botId: string;
    readonly connectionId: string;
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly adapterCommand: string;
    readonly expiresAt: Date;
  }): void {
    this.#database.prepare(`INSERT INTO pending_inputs
      (bot_id,connection_id,telegram_user_id,telegram_chat_id,adapter_command,expires_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(bot_id,telegram_user_id,telegram_chat_id) DO UPDATE SET
        connection_id=excluded.connection_id,adapter_command=excluded.adapter_command,expires_at=excluded.expires_at`)
      .run(input.botId, input.connectionId, input.telegramUserId, input.chatId, input.adapterCommand, input.expiresAt.toISOString());
  }

  getPendingInput(input: { readonly botId: string; readonly telegramUserId: string; readonly chatId: string; readonly now: Date }): PendingInputRecord | undefined {
    const row = this.#database.prepare(`SELECT p.bot_id,p.connection_id,p.telegram_user_id,p.telegram_chat_id,p.adapter_command,p.expires_at
      FROM pending_inputs p JOIN connections c ON c.id=p.connection_id
      WHERE p.bot_id=? AND p.telegram_user_id=? AND p.telegram_chat_id=? AND p.expires_at>? AND c.state='enabled'`)
      .get(input.botId, input.telegramUserId, input.chatId, input.now.toISOString()) as unknown as {
        readonly bot_id: string;
        readonly connection_id: string;
        readonly telegram_user_id: string;
        readonly telegram_chat_id: string;
        readonly adapter_command: string;
        readonly expires_at: string;
      } | undefined;
    if (row === undefined) {
      this.clearPendingInput(input.botId, input.telegramUserId, input.chatId);
      return undefined;
    }
    const target = this.getConnectionById(row.connection_id);
    if (target === undefined) return undefined;
    return {
      botId: row.bot_id,
      connection: target,
      telegramUserId: row.telegram_user_id,
      chatId: row.telegram_chat_id,
      adapterCommand: row.adapter_command,
      expiresAt: row.expires_at,
    };
  }

  clearPendingInput(botId: string, telegramUserId: string, chatId: string): boolean {
    return Number(this.#database.prepare("DELETE FROM pending_inputs WHERE bot_id=? AND telegram_user_id=? AND telegram_chat_id=?")
      .run(botId, telegramUserId, chatId).changes) > 0;
  }

  acceptUpdate(botId: string, updateId: string, body: unknown, now: Date): boolean {
    if (this.#database.prepare("SELECT 1 FROM telegram_updates WHERE bot_id=? AND update_id=?").get(botId, updateId) !== undefined) return false;
    this.#requireCapacity("telegram_updates", JSON.stringify(body));
    return Number(this.#database.prepare(`INSERT OR IGNORE INTO telegram_updates
      (bot_id,update_id,body_json,state,next_attempt_at,received_at) VALUES (?,?,?,'queued',?,?)`)
      .run(botId, updateId, JSON.stringify(body), now.toISOString(), now.toISOString()).changes) > 0;
  }

  claimUpdate(now: Date): PendingUpdate | undefined {
    return this.transaction(() => {
      const row = this.#database.prepare(`SELECT bot_id,update_id,body_json,attempts FROM telegram_updates
        WHERE state IN ('queued','failed') AND next_attempt_at<=? ORDER BY received_at LIMIT 1`)
        .get(now.toISOString()) as unknown as { readonly bot_id: string; readonly update_id: string; readonly body_json: string; readonly attempts: number } | undefined;
      if (row === undefined) return undefined;
      this.#database.prepare("UPDATE telegram_updates SET state='processing', attempts=attempts+1 WHERE bot_id=? AND update_id=?")
        .run(row.bot_id, row.update_id);
      return { botId: row.bot_id, updateId: row.update_id, body: JSON.parse(row.body_json) as unknown, attempts: row.attempts + 1 };
    });
  }

  completeUpdate(botId: string, updateId: string, now: Date): void {
    this.#database.prepare("UPDATE telegram_updates SET state='completed',completed_at=?,last_error=NULL,body_json='{}' WHERE bot_id=? AND update_id=?")
      .run(now.toISOString(), botId, updateId);
  }

  failUpdate(botId: string, updateId: string, error: string, retryAt: Date): void {
    this.#database.prepare("UPDATE telegram_updates SET state='failed',last_error=?,next_attempt_at=? WHERE bot_id=? AND update_id=?")
      .run(error.slice(0, 128), retryAt.toISOString(), botId, updateId);
  }

  createCallback(input: { readonly token: string; readonly connectionId: string; readonly telegramUserId: string; readonly chatId: string; readonly command: string; readonly arguments: Readonly<Record<string, unknown>>; readonly expiresAt: Date }): void {
    this.#requireCapacity("callbacks", JSON.stringify(input.arguments));
    this.#database.prepare(`INSERT INTO callbacks
      (token,connection_id,telegram_user_id,telegram_chat_id,command,arguments_json,expires_at)
      VALUES (?,?,?,?,?,?,?)`).run(
        input.token, input.connectionId, input.telegramUserId, input.chatId,
        input.command, JSON.stringify(input.arguments), input.expiresAt.toISOString(),
      );
  }

  getCallback(input: { readonly token: string; readonly telegramUserId: string; readonly chatId: string; readonly now: Date }): { readonly connection: ConnectionRecord; readonly command: string; readonly arguments: Readonly<Record<string, unknown>> } | undefined {
    const row = this.#database.prepare(`SELECT connection_id,command,arguments_json FROM callbacks
      WHERE token=? AND telegram_user_id=? AND telegram_chat_id=? AND consumed_at IS NULL AND expires_at>?`)
      .get(input.token, input.telegramUserId, input.chatId, input.now.toISOString()) as unknown as { readonly connection_id: string; readonly command: string; readonly arguments_json: string } | undefined;
    if (row === undefined) return undefined;
    const target = this.getConnectionById(row.connection_id);
    if (target === undefined || target.state !== "enabled") return undefined;
    return { connection: target, command: row.command, arguments: JSON.parse(row.arguments_json) as Readonly<Record<string, unknown>> };
  }

  consumeCallback(token: string, now: Date): void {
    this.#database.prepare("UPDATE callbacks SET consumed_at=? WHERE token=? AND consumed_at IS NULL").run(now.toISOString(), token);
  }

  enqueueDelivery(input: { readonly id: string; readonly botId: string; readonly chatId: string; readonly payload: Readonly<Record<string, unknown>>; readonly idempotencyKey: string; readonly now: Date }): boolean {
    if (this.#database.prepare("SELECT 1 FROM delivery_outbox WHERE idempotency_key=?").get(input.idempotencyKey) !== undefined) return false;
    this.#requireCapacity("delivery_outbox", JSON.stringify(input.payload));
    return Number(this.#database.prepare(`INSERT OR IGNORE INTO delivery_outbox
      (id,bot_id,chat_id,payload_json,idempotency_key,state,next_attempt_at,created_at)
      VALUES (?,?,?,?,?,'queued',?,?)`).run(
        input.id, input.botId, input.chatId, JSON.stringify(input.payload), input.idempotencyKey,
        input.now.toISOString(), input.now.toISOString(),
      ).changes) > 0;
  }

  claimDelivery(now: Date): PendingDelivery | undefined {
    return this.transaction(() => {
      const row = this.#database.prepare(`SELECT id,bot_id,chat_id,payload_json,attempts FROM delivery_outbox
        WHERE state IN ('queued','failed') AND next_attempt_at<=? ORDER BY created_at LIMIT 1`)
        .get(now.toISOString()) as unknown as { readonly id: string; readonly bot_id: string; readonly chat_id: string; readonly payload_json: string; readonly attempts: number } | undefined;
      if (row === undefined) return undefined;
      this.#database.prepare("UPDATE delivery_outbox SET state='processing',attempts=attempts+1 WHERE id=?").run(row.id);
      return { id: row.id, botId: row.bot_id, chatId: row.chat_id, payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>, attempts: row.attempts + 1 };
    });
  }

  completeDelivery(id: string, now: Date): void {
    this.#database.prepare("UPDATE delivery_outbox SET state='completed',completed_at=?,last_error=NULL,payload_json='{}' WHERE id=?")
      .run(now.toISOString(), id);
  }

  failDelivery(id: string, error: string, retryAt: Date): void {
    this.#database.prepare("UPDATE delivery_outbox SET state='failed',last_error=?,next_attempt_at=? WHERE id=?")
      .run(error.slice(0, 128), retryAt.toISOString(), id);
  }

}

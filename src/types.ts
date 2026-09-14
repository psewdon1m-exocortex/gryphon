export interface TelegramBotIdentity {
  readonly id: string;
  readonly isBot: boolean;
  readonly username?: string;
}

export interface TelegramTransport {
  getMe(): Promise<TelegramBotIdentity>;
  setWebhook(input: {
    readonly url: string;
    readonly secretToken: string;
    readonly maxConnections: number;
  }): Promise<void>;
  setCommands(input: {
    readonly chatId?: string;
    readonly commands: readonly TelegramCommand[];
  }): Promise<void>;
  sendMessage(input: {
    readonly chatId: string;
    readonly text: string;
    readonly replyMarkup?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  answerCallbackQuery(input: {
    readonly callbackQueryId: string;
    readonly text?: string;
    readonly showAlert?: boolean;
  }): Promise<void>;
}

export interface TelegramCommand {
  readonly command: string;
  readonly description: string;
}

export interface TelegramActor {
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly displayName?: string;
}

export interface CommandEnvelope {
  readonly schema: "exocortex.telegram.command.v1";
  readonly eventId: string;
  readonly correlationId: string;
  readonly connectionId: string;
  readonly serviceId: string;
  readonly actor: TelegramActor;
  readonly command: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ResponseButton {
  readonly text: string;
  readonly command: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface ReplyKeyboard {
  readonly persistent: true;
  readonly resize: boolean;
  readonly placeholder?: string;
  readonly rows: readonly (readonly ResponseButton[])[];
}

export interface ExpectedInput {
  readonly command: string;
  readonly expiresInSeconds: number;
}

export interface ResponseAction {
  readonly type: "send_message";
  readonly text: string;
  readonly buttons?: readonly (readonly ResponseButton[])[];
  readonly replyKeyboard?: ReplyKeyboard;
  readonly expectInput?: ExpectedInput;
}

export interface CommandResponse {
  readonly schema: "exocortex.telegram.response.v1";
  readonly actions: readonly ResponseAction[];
}

export interface BotRecord {
  readonly id: string;
  readonly telegramBotId: string;
  readonly alias: string;
  readonly username?: string;
  readonly tokenPath: string;
  readonly tokenFingerprint: string;
  readonly webhookKey: string;
  readonly webhookSecret: string;
  readonly state: "starting" | "ready" | "degraded" | "disabled";
}

export interface ConnectionRecord {
  readonly id: string;
  readonly serviceId: string;
  readonly botId: string;
  readonly commandPrefix: string;
  readonly adapterUrl: string;
  readonly serviceTokenPath: string;
  readonly state: "enabled" | "disabled";
}

export interface CommandCatalogEntry {
  readonly name: string;
  readonly adapterCommand: string;
  readonly description: string;
}

export interface ConnectionCommandRecord extends CommandCatalogEntry {
  readonly connectionId: string;
  readonly botId: string;
  readonly serviceId: string;
}

export type TransportFactory = (token: string) => TelegramTransport;
export type AdapterDispatcher = (
  connection: ConnectionRecord,
  token: string,
  envelope: CommandEnvelope,
) => Promise<CommandResponse>;

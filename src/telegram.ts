import type { TelegramBotIdentity, TelegramTransport } from "./types.js";

interface TelegramEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
}

export class TelegramProviderError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}

export class TelegramHttpTransport implements TelegramTransport {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(input: { readonly token: string; readonly baseUrl?: string; readonly timeoutMs?: number }) {
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(input.token)) throw new TelegramProviderError("invalid_bot_token");
    const base = new URL(input.baseUrl ?? "https://api.telegram.org/");
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.#token = input.token;
    this.#baseUrl = base.toString();
    this.#timeoutMs = input.timeoutMs ?? 10_000;
  }

  async #request<T>(method: string, body: Readonly<Record<string, unknown>>): Promise<T> {
    try {
      const response = await fetch(new URL(`./bot${this.#token}/${method}`, this.#baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const envelope = await response.json() as TelegramEnvelope<T>;
      if (!response.ok || !envelope.ok || envelope.result === undefined) throw new TelegramProviderError("telegram_request_failed");
      return envelope.result;
    } catch (error) {
      throw error instanceof TelegramProviderError
        ? error
        : new TelegramProviderError("telegram_unavailable", { cause: error });
    }
  }

  async getMe(): Promise<TelegramBotIdentity> {
    const value = await this.#request<{ readonly id: number; readonly is_bot: boolean; readonly username?: string }>("getMe", {});
    return {
      id: String(value.id),
      isBot: value.is_bot,
      ...(value.username === undefined ? {} : { username: value.username }),
    };
  }

  async setWebhook(input: { readonly url: string; readonly secretToken: string; readonly maxConnections: number }): Promise<void> {
    await this.#request<boolean>("setWebhook", {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: ["message", "callback_query"],
      max_connections: input.maxConnections,
      drop_pending_updates: false,
    });
  }

  async sendMessage(input: { readonly chatId: string; readonly text: string; readonly replyMarkup?: Readonly<Record<string, unknown>> }): Promise<void> {
    await this.#request<Record<string, unknown>>("sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup }),
    });
  }

  async answerCallbackQuery(input: { readonly callbackQueryId: string; readonly text?: string; readonly showAlert?: boolean }): Promise<void> {
    await this.#request<boolean>("answerCallbackQuery", {
      callback_query_id: input.callbackQueryId,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.showAlert === undefined ? {} : { show_alert: input.showAlert }),
    });
  }
}

import http from "node:http";
import { describe, expect, it } from "vitest";
import { TelegramHttpTransport } from "../src/telegram.js";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${String(address.port)}/`;
}

describe("Telegram transport", () => {
  it("sets default and private-chat command scopes", async () => {
    const requests: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      requests.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, result: true }));
    });
    const origin = await listen(server);
    try {
      const transport = new TelegramHttpTransport({ token: "100015:oooooooooooooooooooooooooooooooo", baseUrl: origin });
      const commands = [{ command: "drop", description: "Create a Drop Point code" }];
      await transport.setCommands({ commands });
      await transport.setCommands({ chatId: "42", commands });
      expect(requests).toEqual([
        expect.objectContaining({
          path: expect.stringContaining("/setMyCommands"),
          body: { commands, scope: { type: "default" } },
        }),
        expect.objectContaining({
          path: expect.stringContaining("/setMyCommands"),
          body: { commands, scope: { type: "chat", chat_id: "42" } },
        }),
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

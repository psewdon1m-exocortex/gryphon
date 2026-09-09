import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GryphonConfig } from "../src/config.js";
import { GryphonGateway } from "../src/gateway.js";
import { createAdminServer, createClientServer, createPublicServer } from "../src/http.js";
import { GryphonRepository } from "../src/repository.js";
import type { TelegramTransport } from "../src/types.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Gryphon HTTP boundaries", () => {
  it("keeps secrets out of admin responses and routes authenticated webhook and notification traffic", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-http-"));
    temporary.push(directory);
    const config: GryphonConfig = {
      version: "0.1.0-test",
      dataDirectory: directory,
      publicOrigin: "https://gryphon.test",
      publicHost: "127.0.0.1",
      publicPort: 18_380,
      adminSocket: path.join(directory, "admin.sock"),
      clientSocket: path.join(directory, "client.sock"),
      clientsDirectory: path.join(directory, "clients"),
      telegramApiBaseUrl: "https://api.telegram.org/",
      providerTimeoutMs: 1_000,
      webhookMaxBytes: 65_536,
      webhookMaxConnections: 8,
    };
    let webhook: { readonly url: string; readonly secretToken: string } | undefined;
    const sent: string[] = [];
    const transport: TelegramTransport = {
      getMe: () => Promise.resolve({ id: "10001", isBot: true, username: "test_bot" }),
      setWebhook: (input) => { webhook = input; return Promise.resolve(); },
      sendMessage: (input) => { sent.push(input.text); return Promise.resolve(); },
      answerCallbackQuery: () => Promise.resolve(),
    };
    const repository = new GryphonRepository(path.join(directory, "state.sqlite"));
    const gateway = new GryphonGateway({
      repository,
      config,
      pepper: Buffer.alloc(32, 7),
      transportFactory: () => transport,
      adapterDispatcher: async (_connection, _token, envelope) => ({
        schema: "exocortex.telegram.response.v1",
        actions: [{ type: "send_message", text: `${envelope.serviceId}:${envelope.command}` }],
      }),
    });
    const publicServer = createPublicServer(gateway, config);
    const adminServer = createAdminServer(gateway);
    const clientServer = createClientServer(gateway);
    const [publicOrigin, adminOrigin, clientOrigin] = await Promise.all([listen(publicServer), listen(adminServer), listen(clientServer)]);
    try {
      const serviceToken = "chronos-service-token-value-0001";
      const botToken = "10001:abcdefghijklmnopqrstuvwxyzABCDE";
      fs.mkdirSync(config.clientsDirectory, { recursive: true });
      fs.writeFileSync(path.join(config.clientsDirectory, "chronos.token"), serviceToken);
      const connected = await fetch(`${adminOrigin}/v1/bots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: "chronos", botToken }),
      });
      expect(connected.status).toBe(201);
      const connectionBody = JSON.stringify(await connected.json());
      expect(connectionBody).not.toContain(botToken);
      expect(connectionBody).not.toContain(serviceToken);
      expect(connectionBody).not.toContain("tokenPath");
      const botList = await fetch(`${adminOrigin}/v1/bots`);
      expect(await botList.json()).toMatchObject({ schema: "exocortex.gryphon.bots.v1", bots: [{ alias: "chronos", state: "ready" }] });

      const initialStatus = await fetch(`${clientOrigin}/v1/service`, { headers: { "Authorization": `Bearer ${serviceToken}` } });
      expect(initialStatus.status).toBe(200);
      expect(await initialStatus.json()).toMatchObject({ serviceId: "chronos", connected: false, state: "unlinked", bot: null });

      const available = await fetch(`${clientOrigin}/v1/service/bots`, { headers: { "Authorization": `Bearer ${serviceToken}` } });
      expect(available.status).toBe(200);
      const availableBody = await available.json() as { readonly bots: readonly { readonly id: string }[] };
      expect(availableBody.bots).toHaveLength(1);
      const serviceConnection = await fetch(`${clientOrigin}/v1/service/connection`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${serviceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ botId: availableBody.bots[0]!.id, commandPrefix: "chronos", adapterUrl: "http://chronos.test/api/internal/gryphon/command" }),
      });
      expect(serviceConnection.status).toBe(201);

      const challengeResponse = await fetch(`${clientOrigin}/v1/service/link-challenges`, { method: "POST", headers: { "Authorization": `Bearer ${serviceToken}` } });
      const challenge = await challengeResponse.json() as { readonly command: string };
      expect(webhook).toBeDefined();
      const webhookPath = new URL(webhook!.url).pathname;
      const forgedWebhook = await fetch(`${publicOrigin}${webhookPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
        body: JSON.stringify({ update_id: 999 }),
      });
      expect(forgedWebhook.status).toBe(401);
      const link = await fetch(`${publicOrigin}${webhookPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": webhook!.secretToken },
        body: JSON.stringify({ update_id: 1, message: { text: challenge.command, from: { id: 42, is_bot: false, first_name: "Owner" }, chat: { id: 42, type: "private" } } }),
      });
      expect(link.status).toBe(202);
      await gateway.drain();

      const serviceStatus = await fetch(`${clientOrigin}/v1/service`, { headers: { "Authorization": `Bearer ${serviceToken}` } });
      expect(serviceStatus.status).toBe(200);
      expect(await serviceStatus.json()).toMatchObject({ version: "0.1.0-test", serviceId: "chronos", connected: true, bot: { id: availableBody.bots[0]!.id }, binding: { linkedAt: expect.any(String) } });
      const crossService = await fetch(`${clientOrigin}/v1/service`, { headers: { "Authorization": "Bearer wrong-token" } });
      expect(crossService.status).toBe(401);

      const forgedNotification = await fetch(`${clientOrigin}/v1/service/notifications`, {
        method: "POST",
        headers: { "Authorization": "Bearer wrong-token", "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Forged", idempotencyKey: "forged-0001" }),
      });
      expect(forgedNotification.status).toBe(401);
      const notification = await fetch(`${clientOrigin}/v1/service/notifications`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${serviceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Chronos reminder", idempotencyKey: "reminder-0001" }),
      });
      expect(notification.status).toBe(202);
      await gateway.drain();
      expect(sent).toContain("chronos linked to this Telegram account.");
      expect(sent).toContain("Chronos reminder");

      const disconnected = await fetch(`${clientOrigin}/v1/service/connection`, { method: "DELETE", headers: { "Authorization": `Bearer ${serviceToken}` } });
      expect(disconnected.status).toBe(200);
      expect(await disconnected.json()).toEqual({ disconnected: true });
      const finalStatus = await fetch(`${clientOrigin}/v1/service`, { headers: { "Authorization": `Bearer ${serviceToken}` } });
      expect(await finalStatus.json()).toMatchObject({ serviceId: "chronos", connected: false, state: "unlinked", bot: null, binding: null });
    } finally {
      await Promise.all([close(publicServer), close(adminServer), close(clientServer)]);
      repository.close();
    }
  });
});

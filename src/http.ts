import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { GryphonConfig } from "./config.js";
import { GryphonError, GryphonGateway } from "./gateway.js";
import { RepositoryCapacityError } from "./repository.js";

async function jsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.byteLength;
    if (size > maximumBytes) throw new GryphonError("payload_too_large", 413);
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GryphonError("invalid_json");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof RepositoryCapacityError) {
    response.setHeader("Retry-After", "60");
    return send(response, 503, { error: "queue_capacity_exceeded" });
  }
  const value = error instanceof GryphonError ? error : new GryphonError("internal_error", 500);
  send(response, value.status, { error: value.code });
}

export function createPublicServer(gateway: GryphonGateway, config: GryphonConfig): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health/live") return send(response, 200, { status: "ok" });
      const match = /^\/v1\/telegram\/webhook\/([A-Za-z0-9_-]{24})$/.exec(url.pathname);
      if (request.method === "POST" && match?.[1] !== undefined) {
        const body = await jsonBody(request, config.webhookMaxBytes);
        const result = gateway.acceptUpdate(match[1], String(request.headers["x-telegram-bot-api-secret-token"] ?? ""), body);
        send(response, 202, result);
        void gateway.drain();
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) { fail(response, error); }
  });
}

export function createClientServer(gateway: GryphonGateway): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const authorization = String(request.headers.authorization ?? "");
      if (request.method === "GET" && url.pathname === "/v1/health") return send(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/v1/service") return send(response, 200, gateway.serviceStatus(authorization));
      if (request.method === "GET" && url.pathname === "/v1/service/bots") return send(response, 200, gateway.serviceBots(authorization));
      if (request.method === "PUT" && url.pathname === "/v1/service/connection") {
        const body = await jsonBody(request, 16_384);
        if (typeof body !== "object" || body === null) throw new GryphonError("invalid_connection");
        const value = body as Record<string, unknown>;
        for (const field of ["botId", "commandPrefix", "adapterUrl"] as const) {
          if (typeof value[field] !== "string") throw new GryphonError("invalid_connection");
        }
        const result = gateway.connectService(authorization, {
          botId: value.botId as string,
          commandPrefix: value.commandPrefix as string,
          adapterUrl: value.adapterUrl as string,
        });
        send(response, 201, result);
        void gateway.drain();
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/service/connection") {
        const result = gateway.disconnectService(authorization);
        send(response, 200, result);
        void gateway.drain();
        return;
      }
      if (request.method === "PUT" && url.pathname === "/v1/service/command-catalog") {
        const result = gateway.syncServiceCommandCatalog(authorization, await jsonBody(request, 65_536));
        send(response, 200, result);
        void gateway.drain();
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/service/link-challenges") return send(response, 201, gateway.issueServiceLink(authorization));
      if (request.method === "DELETE" && url.pathname === "/v1/service/binding") {
        const result = await gateway.revokeServiceLink(authorization);
        send(response, 200, result);
        void gateway.drain();
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/service/notifications") {
        const body = await jsonBody(request, 16_384);
        if (typeof body !== "object" || body === null) throw new GryphonError("invalid_notification");
        const candidate = body as Record<string, unknown>;
        if (typeof candidate.text !== "string" || typeof candidate.idempotencyKey !== "string") throw new GryphonError("invalid_notification");
        const result = gateway.notifyService(authorization, { text: candidate.text, idempotencyKey: candidate.idempotencyKey });
        send(response, 202, result);
        void gateway.drain();
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) { fail(response, error); }
  });
}

export function createAdminServer(gateway: GryphonGateway): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/v1/status") return send(response, 200, gateway.status());
      if (request.method === "GET" && url.pathname === "/v1/bots") return send(response, 200, gateway.botStatus());
      if (request.method === "POST" && url.pathname === "/v1/bots") {
        const body = await jsonBody(request, 16_384);
        if (typeof body !== "object" || body === null) throw new GryphonError("invalid_bot");
        const value = body as Record<string, unknown>;
        for (const field of ["alias", "botToken"] as const) {
          if (typeof value[field] !== "string") throw new GryphonError("invalid_bot");
        }
        const result = await gateway.connectBot({
          alias: value.alias as string,
          botToken: value.botToken as string,
        });
        return send(response, 201, {
          reusedBot: result.reusedBot,
          bot: {
            id: result.bot.id,
            telegramBotId: result.bot.telegramBotId,
            alias: result.bot.alias,
            username: result.bot.username,
            state: result.bot.state,
          },
        });
      }
      const issue = /^\/v1\/links\/([a-z][a-z0-9-]{1,47})$/.exec(url.pathname);
      if (request.method === "POST" && issue?.[1] !== undefined) return send(response, 201, gateway.issueLink(issue[1]));
      if (request.method === "DELETE" && issue?.[1] !== undefined) {
        const result = await gateway.revokeLink(issue[1]);
        send(response, 200, result);
        void gateway.drain();
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) { fail(response, error); }
  });
}

export async function listenTcp(server: http.Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
}

export async function listenUnix(server: http.Server, socket: string, mode: number): Promise<void> {
  if (process.platform !== "win32") {
    const resolved = path.resolve(socket);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o750 });
    if (fs.existsSync(resolved)) {
      const current = fs.lstatSync(resolved);
      if (!current.isSocket()) throw new Error(`${socket} exists and is not a socket`);
      fs.unlinkSync(resolved);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => { server.off("error", reject); resolve(); });
  });
  if (process.platform !== "win32") fs.chmodSync(socket, mode);
}

export function listenAdmin(server: http.Server, socket: string): Promise<void> {
  return listenUnix(server, socket, 0o600);
}

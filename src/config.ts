import path from "node:path";
import fs from "node:fs";

function packageVersion(): string {
  try {
    const packageFile = new URL("../package.json", import.meta.url);
    const value = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { readonly version?: unknown };
    return typeof value.version === "string" ? value.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export interface GryphonConfig {
  readonly version: string;
  readonly dataDirectory: string;
  readonly publicOrigin: string;
  readonly publicHost: string;
  readonly publicPort: number;
  readonly adminSocket: string;
  readonly clientSocket: string;
  readonly telegramApiBaseUrl: string;
  readonly providerTimeoutMs: number;
  readonly webhookMaxBytes: number;
  readonly webhookMaxConnections: number;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

export function loadConfig(): GryphonConfig {
  const dataDirectory = path.resolve(process.env.GRYPHON_DATA_DIR ?? "data");
  const publicOrigin = (process.env.GRYPHON_PUBLIC_ORIGIN ?? "").trim().replace(/\/$/, "");
  if (publicOrigin && new URL(publicOrigin).protocol !== "https:") throw new Error("GRYPHON_PUBLIC_ORIGIN must use HTTPS");
  return {
    version: process.env.GRYPHON_VERSION ?? packageVersion(),
    dataDirectory,
    publicOrigin,
    publicHost: process.env.GRYPHON_PUBLIC_HOST ?? "127.0.0.1",
    publicPort: integer("GRYPHON_PUBLIC_PORT", 18380, 1, 65_535),
    adminSocket: process.env.GRYPHON_ADMIN_SOCKET ?? (process.platform === "win32" ? "\\\\.\\pipe\\exocortex-gryphon-admin" : "/run/gryphon/admin.sock"),
    clientSocket: process.env.GRYPHON_CLIENT_SOCKET ?? (process.platform === "win32" ? "\\\\.\\pipe\\exocortex-gryphon-client" : "/run/gryphon/client.sock"),
    telegramApiBaseUrl: process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org/",
    providerTimeoutMs: integer("TELEGRAM_PROVIDER_TIMEOUT_MS", 10_000, 1_000, 60_000),
    webhookMaxBytes: integer("TELEGRAM_WEBHOOK_MAX_BYTES", 65_536, 4_096, 1_048_576),
    webhookMaxConnections: integer("TELEGRAM_WEBHOOK_MAX_CONNECTIONS", 8, 1, 100),
  };
}

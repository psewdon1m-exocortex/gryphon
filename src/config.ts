import path from "node:path";
import fs from "node:fs";

function packageVersion(): string {
  try {
    const packageFile = new URL("../package.json", import.meta.url);
    const value = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { readonly version?: unknown };
    return typeof value.version === "string" ? value.version : "0.1.4";
  } catch {
    return "0.1.4";
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
  readonly clientsDirectory: string;
  readonly telegramApiBaseUrl: string;
  readonly providerTimeoutMs: number;
  readonly webhookMaxBytes: number;
  readonly webhookMaxConnections: number;
  readonly kernelOrigin?: string;
  readonly kernelTokenFile?: string;
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
  const kernelOrigin = (process.env.GRYPHON_KERNEL_URL ?? process.env.KERNEL_URL ?? "").trim();
  const kernelTokenFile = (process.env.GRYPHON_KERNEL_TOKEN_FILE ?? "").trim();
  if (kernelOrigin) {
    const url = new URL(kernelOrigin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("GRYPHON_KERNEL_URL must be a private HTTPS origin");
  }
  if (process.env.NODE_ENV === "production" && (!kernelOrigin || !kernelTokenFile)) throw new Error("Gryphon production discovery requires Kernel URL and protected token file");
  return {
    version: process.env.GRYPHON_VERSION ?? packageVersion(),
    dataDirectory,
    publicOrigin,
    ...(kernelOrigin ? { kernelOrigin } : {}),
    ...(kernelTokenFile ? { kernelTokenFile: path.resolve(kernelTokenFile) } : {}),
    publicHost: process.env.GRYPHON_PUBLIC_HOST ?? "127.0.0.1",
    publicPort: integer("GRYPHON_PUBLIC_PORT", 18380, 1, 65_535),
    adminSocket: process.env.GRYPHON_ADMIN_SOCKET ?? (process.platform === "win32" ? "\\\\.\\pipe\\exocortex-gryphon-admin" : "/run/gryphon-admin/admin.sock"),
    clientSocket: process.env.GRYPHON_CLIENT_SOCKET ?? (process.platform === "win32" ? "\\\\.\\pipe\\exocortex-gryphon-client" : "/run/gryphon/client.sock"),
    clientsDirectory: path.resolve(process.env.GRYPHON_CLIENTS_DIR ?? (process.platform === "win32" ? path.join(dataDirectory, "clients") : "/etc/gryphon/clients")),
    telegramApiBaseUrl: process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org/",
    providerTimeoutMs: integer("TELEGRAM_PROVIDER_TIMEOUT_MS", 10_000, 1_000, 60_000),
    webhookMaxBytes: integer("TELEGRAM_WEBHOOK_MAX_BYTES", 65_536, 4_096, 1_048_576),
    webhookMaxConnections: integer("TELEGRAM_WEBHOOK_MAX_CONNECTIONS", 8, 1, 100),
  };
}

import fs from "node:fs/promises";
import { nativeFetch } from "./http-transport.js";
import type { GryphonConfig } from "./config.js";

export async function registeredOrigin(config: GryphonConfig, service: string, fetchImpl = nativeFetch): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(service) || !config.kernelOrigin || !config.kernelTokenFile) throw new Error("kernel_not_configured");
  const token = (await fs.readFile(config.kernelTokenFile, "utf8")).trim();
  if (!token || token.length > 8192) throw new Error("kernel_token_invalid");
  const hostKey = `services.${service}.sni`, portKey = `services.${service}.port`;
  const result = await fetchImpl(new URL("/api/v1/register/resolve", config.kernelOrigin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(config.providerTimeoutMs),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ keys: [hostKey, portKey] }),
  });
  if (!result.ok) throw new Error("kernel_discovery_failed");
  const reader = result.body?.getReader();
  if (!reader) throw new Error("kernel_response_invalid");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      const value: unknown = item.value;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > 16384) throw new Error("kernel_response_invalid");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { schema?: string; values?: Record<string, { value?: unknown }> };
  const host = body.values?.[hostKey]?.value, port = body.values?.[portKey]?.value;
  if (body.schema !== "exocortex.register.resolution.v1" || typeof host !== "string" || host.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)
    || typeof port !== "string" || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("kernel_origin_invalid");
  return new URL(`https://${host}:${port}`).origin;
}

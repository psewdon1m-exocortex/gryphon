#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { loadConfig } from "./config.js";

interface CliResponse {
  readonly status: number;
  readonly body: unknown;
}

function request(socketPath: string, method: string, requestPath: string, body?: unknown): Promise<CliResponse> {
  return new Promise((resolve, reject) => {
    const value = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = http.request({
      socketPath,
      path: requestPath,
      method,
      headers: value === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(value) },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        try { resolve({ status: incoming.statusCode ?? 500, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.once("error", reject);
    if (value !== undefined) outgoing.write(value);
    outgoing.end();
  });
}

function option(argumentsValue: readonly string[], name: string, required = true): string {
  const index = argumentsValue.indexOf(name);
  const value = index < 0 ? undefined : argumentsValue[index + 1];
  if (value === undefined && required) throw new Error(`Missing ${name}`);
  return value ?? "";
}

function secretFile(filename: string): string {
  const value = fs.readFileSync(filename, "utf8").replace(/[\r\n]+$/, "");
  if (!value) throw new Error(`Secret file is empty: ${filename}`);
  return value;
}

function help(): never {
  process.stderr.write(`Usage:
  gryphon status
  gryphon version
  gryphon connect SERVICE --bot-token-file PATH --service-token-file PATH --adapter URL [--prefix PREFIX] [--alias ALIAS]
  gryphon link issue SERVICE
  gryphon link revoke SERVICE
`);
  process.exit(2);
}

const argumentsValue = process.argv.slice(2);
const config = loadConfig();
let result: CliResponse;
if (argumentsValue[0] === "version") {
  process.stdout.write(`${config.version}\n`);
  process.exit(0);
} else if (argumentsValue[0] === "status") {
  result = await request(config.adminSocket, "GET", "/v1/status");
} else if (argumentsValue[0] === "connect" && argumentsValue[1] !== undefined) {
  const serviceId = argumentsValue[1];
  result = await request(config.adminSocket, "POST", "/v1/connections", {
    serviceId,
    commandPrefix: option(argumentsValue, "--prefix", false) || serviceId.replace(/-/g, "_"),
    alias: option(argumentsValue, "--alias", false) || serviceId,
    adapterUrl: option(argumentsValue, "--adapter"),
    botToken: secretFile(option(argumentsValue, "--bot-token-file")),
    serviceToken: secretFile(option(argumentsValue, "--service-token-file")),
  });
} else if (argumentsValue[0] === "link" && argumentsValue[1] === "issue" && argumentsValue[2] !== undefined) {
  result = await request(config.adminSocket, "POST", `/v1/links/${encodeURIComponent(argumentsValue[2])}`);
} else if (argumentsValue[0] === "link" && argumentsValue[1] === "revoke" && argumentsValue[2] !== undefined) {
  result = await request(config.adminSocket, "DELETE", `/v1/links/${encodeURIComponent(argumentsValue[2])}`);
} else {
  help();
}

process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
if (result.status >= 400) process.exitCode = 1;

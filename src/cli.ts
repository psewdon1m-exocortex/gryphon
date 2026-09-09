#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { loadConfig } from "./config.js";
import { promptSecret } from "./secret-prompt.js";

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
  gryphon bot list
  gryphon bot connect ALIAS [--bot-token-file PATH]
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
} else if (argumentsValue[0] === "bot" && argumentsValue[1] === "list") {
  result = await request(config.adminSocket, "GET", "/v1/bots");
} else if (argumentsValue[0] === "bot" && argumentsValue[1] === "connect" && argumentsValue[2] !== undefined) {
  const tokenFile = option(argumentsValue, "--bot-token-file", false);
  const botToken = tokenFile ? secretFile(tokenFile) : await promptSecret("Telegram bot token: ");
  process.stderr.write("Verifying bot with Telegram...\n");
  result = await request(config.adminSocket, "POST", "/v1/bots", {
    alias: argumentsValue[2],
    botToken,
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

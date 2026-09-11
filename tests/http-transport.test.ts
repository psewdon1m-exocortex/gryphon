import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { test, expect } from "vitest";

test("production jitless transport sends authenticated JSON, rejects redirects and bounds responses", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/ok" }); response.end(); return; }
    if (request.url === "/large") { response.end(Buffer.alloc(2 * 1024 * 1024 + 1)); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ authorized: request.headers.authorization === "Bearer synthetic-token" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("listener missing");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gryphon-http-"));
  const modulePath = path.join(directory, "transport.mjs");
  const source = await fs.readFile(new URL("../src/http-transport.ts", import.meta.url), "utf8");
  await fs.writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const moduleUrl = pathToFileURL(modulePath).href;
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const script = `import {nativeFetch} from ${JSON.stringify(moduleUrl)};
      const response = await nativeFetch(${JSON.stringify(origin + "/ok")}, {headers:{Authorization:'Bearer synthetic-token'}});
      if (!(await response.json()).authorized) throw Error('authentication lost');
      for(const suffix of ['/redirect','/large']) {
        let rejected=false; try { await nativeFetch(${JSON.stringify(origin)}+suffix); } catch { rejected=true; }
        if(!rejected) throw Error('unsafe response accepted');
      }
      console.log('verified');`;
    const result = await promisify(execFile)(process.execPath, ["--jitless", "--input-type=module", "-e", script], { timeout: 10_000, windowsHide: true });
    expect(result.stdout.trim()).toBe("verified");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.unlink(modulePath); await fs.rmdir(directory); }
});

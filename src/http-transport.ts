import http from "node:http";
import https from "node:https";

/** Bounded HTTP transport compatible with Node --jitless. Built-in fetch's
 * llhttp WebAssembly parser is unavailable in that production sandbox. */
export async function nativeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid_http_origin");
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("unsupported_http_body");
  const body = typeof init.body === "string" ? Buffer.from(init.body) : undefined;
  if (body !== undefined && body.length > 1024 * 1024) throw new Error("http_request_too_large");
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (body !== undefined) headers["content-length"] = String(body.length);
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: init.method ?? "GET", headers,
      ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) { response.destroy(); reject(new Error("http_redirect_rejected")); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { response.destroy(new Error("http_response_too_large")); return; }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) resultHeaders.append(key, item);
          else if (value !== undefined) resultHeaders.set(key, value);
        }
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: resultHeaders }));
      });
    });
    request.once("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("http_timeout")));
    request.end(body);
  });
}

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { promptSecret } from "../src/secret-prompt.js";

describe("secret prompt", () => {
  it("reads from an interactive terminal without echoing the token", async () => {
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.defineProperty(input, "isTTY", { value: true });
    input.setRawMode = vi.fn(() => input);
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    let visible = "";
    output.on("data", (chunk: Buffer) => { visible += chunk.toString("utf8"); });

    const result = promptSecret("Telegram bot token: ", input, output);
    input.write("12345:abcdefghijklmnopqrstuvwxyzABCDE\r");

    await expect(result).resolves.toBe("12345:abcdefghijklmnopqrstuvwxyzABCDE");
    expect(visible).toBe("Telegram bot token: \n");
    expect(visible).not.toContain("abcdefghijklmnopqrstuvwxyzABCDE");
    expect(input.setRawMode).toHaveBeenCalledWith(true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("requires a TTY when no token file is used", async () => {
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    await expect(promptSecret("Telegram bot token: ", input, output)).rejects.toThrow("--bot-token-file");
  });
});

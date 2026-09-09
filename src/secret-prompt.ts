import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function promptSecret(
  label: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    throw new Error("Interactive terminal required; use --bot-token-file for automation.");
  }

  const muted = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  });
  const terminal = createInterface({ input, output: muted, terminal: true });
  let interrupted = false;
  terminal.once("SIGINT", () => {
    interrupted = true;
    terminal.close();
  });
  output.write(label);
  try {
    const value = (await terminal.question("")).trim();
    if (interrupted) throw new Error("Telegram bot token entry cancelled.");
    if (!value) throw new Error("Telegram bot token cannot be empty.");
    return value;
  } catch (error) {
    if (interrupted) throw new Error("Telegram bot token entry cancelled.", { cause: error });
    throw error;
  } finally {
    terminal.close();
    output.write("\n");
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { GryphonRepository, RepositoryCapacityError } from "../src/repository.js";

it("bounds queue records and bytes without evicting pending work or recent deduplication", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-retention-"));
  const filename = path.join(directory, "state.sqlite");
  const repository = new GryphonRepository(filename, { records: 3, bytes: 64 });
  const now = new Date();
  try {
    const bot = repository.createBot({ telegramBotId: "123", alias: "test", tokenPath: "protected-token", tokenFingerprint: "fingerprint", webhookKey: "webhook", webhookSecret: "synthetic" }, now);
    expect(() => repository.acceptUpdate(bot.id, "large", { text: "x".repeat(65) }, now)).toThrow(RepositoryCapacityError);
    for (const id of ["1", "2", "3"]) expect(repository.acceptUpdate(bot.id, id, { text: "message" }, now)).toBe(true);
    repository.completeUpdate(bot.id, "1", now);
    repository.completeUpdate(bot.id, "2", now);
    repository.maintain(new Date(now.getTime() + 29 * 86_400_000));
    expect(repository.acceptUpdate(bot.id, "1", {}, now)).toBe(false);
    expect(() => repository.acceptUpdate(bot.id, "4", {}, now)).toThrow(RepositoryCapacityError);
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT body_json FROM telegram_updates WHERE update_id='1'").get()?.body_json).toBe("{}");
    database.close();
    repository.maintain(new Date(now.getTime() + 31 * 86_400_000));
    expect(repository.claimUpdate(now)?.updateId).toBe("3");
    expect(repository.acceptUpdate(bot.id, "4", {}, now)).toBe(true);
  } finally { repository.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { registeredOrigin } from "../src/kernel.js";

afterEach(() => vi.unstubAllEnvs());

test("production host starts without a Kernel connection and leaves discovery pending", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GRYPHON_KERNEL_URL", "");
  vi.stubEnv("KERNEL_URL", "");
  vi.stubEnv("GRYPHON_KERNEL_TOKEN_FILE", "");
  const config = loadConfig();
  expect(config.kernelOrigin).toBeUndefined();
  expect(config.kernelTokenFile).toBeUndefined();
  await expect(registeredOrigin(config, "gryphon")).rejects.toThrow("kernel_not_configured");
});

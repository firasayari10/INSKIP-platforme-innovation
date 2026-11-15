import { describe, expect, test } from "bun:test";

describe("verrou réseau des tests", () => {
  test("tout appel vers un service externe est refusé", async () => {
    await expect(fetch("https://api.z.ai/api/paas/v4/chat/completions")).rejects.toThrow("Appel réseau interdit");
    await expect(fetch("https://openrouter.ai/api/v1/chat/completions")).rejects.toThrow("Appel réseau interdit");
  });
});

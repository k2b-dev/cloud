import { describe, expect, test } from "bun:test";
import { startNotificationDefinitionRegistration } from "./catalog";

describe("notification catalog registration", () => {
  test("keeps app startup alive and retries while the Core schema is unavailable", async () => {
    let attempts = 0;
    const stop = await startNotificationDefinitionRegistration(
      "rollout-test",
      {},
      {
        retryMs: 1,
        register: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
        },
      },
    );

    for (let index = 0; index < 50 && attempts < 2; index += 1) await Bun.sleep(2);
    stop();
    expect(attempts).toBe(2);
  });

  test("retries while Core has not added a new catalog column yet", async () => {
    let attempts = 0;
    const stop = await startNotificationDefinitionRegistration(
      "rollout-test",
      {},
      {
        retryMs: 1,
        register: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("column does not exist"), { code: "42703" });
        },
      },
    );

    for (let index = 0; index < 50 && attempts < 2; index += 1) await Bun.sleep(2);
    stop();
    expect(attempts).toBe(2);
  });

  test("does not hide non-rollout registration failures", async () => {
    await expect(
      startNotificationDefinitionRegistration(
        "rollout-test",
        {},
        {
          register: async () => {
            throw Object.assign(new Error("permission denied"), { code: "42501" });
          },
        },
      ),
    ).rejects.toThrow("permission denied");
  });

  test("keeps retrying a different failure after rollout waiting", async () => {
    let attempts = 0;
    const stop = await startNotificationDefinitionRegistration(
      "rollout-test",
      {},
      {
        retryMs: 1,
        register: async () => {
          attempts += 1;
          if (attempts < 3) {
            throw Object.assign(new Error(attempts === 1 ? "relation missing" : "permission denied"), {
              code: attempts === 1 ? "42P01" : "42501",
            });
          }
        },
      },
    );

    for (let index = 0; index < 50 && attempts < 3; index += 1) await Bun.sleep(2);
    stop();
    expect(attempts).toBe(3);
  });
});

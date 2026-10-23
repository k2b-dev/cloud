import { describe, expect, test } from "bun:test";
import { startNotificationDefinitionRegistration } from "./catalog";

describe("notification catalog registration", () => {
  for (const sqlState of ["42P01", "42703", "3F000"]) {
    for (const field of ["code", "errno"] as const) {
      test(`keeps startup alive and registers after schema error ${field}=${sqlState}`, async () => {
        let attempts = 0;
        const registered = Promise.withResolvers<void>();
        const stop = await startNotificationDefinitionRegistration(
          "rollout-test",
          {},
          {
            retryMs: 1,
            register: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw Object.assign(
                  new Error("schema is not ready"),
                  field === "errno" ? { code: "ERR_POSTGRES_SERVER_ERROR", errno: sqlState } : { code: sqlState },
                );
              }
              registered.resolve();
            },
          },
        );

        try {
          await registered.promise;
          expect(attempts).toBe(2);
        } finally {
          stop();
        }
      });
    }
  }

  test.each([
    { code: "42501" },
    { code: "ERR_POSTGRES_SERVER_ERROR", errno: "42501" },
    { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" },
    { code: "ERR_POSTGRES_SERVER_ERROR" },
    { code: "42P01", errno: "42501" },
  ])("propagates the original non-schema failure without retrying: %j", async (fields) => {
    let attempts = 0;
    const error = Object.assign(new Error("registration failed"), fields);
    await expect(
      startNotificationDefinitionRegistration(
        "rollout-test",
        {},
        {
          register: async () => {
            attempts += 1;
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
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

import { expect, test } from "bun:test";
import { YAML } from "bun";

test("production gateway can decrypt settings and share public-storage request budgets", async () => {
  const compose: unknown = YAML.parse(await Bun.file(new URL("../../../compose.prod.yml", import.meta.url)).text());
  expect(compose).toMatchObject({
    services: {
      gateway: {
        environment: {
          APP_SECRET: "${APP_SECRET}",
          DATABASE_URL: expect.any(String),
          REDIS_URL: "redis://valkey:6379",
        },
      },
    },
  });
});

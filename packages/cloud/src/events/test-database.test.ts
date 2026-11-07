import { expect, test } from "bun:test";
import { assertTestDatabase } from "./test-database";

test("outbox installation accepts only the literal _test database suffix", () => {
  for (const name of [undefined, "", "cloud", "cloud_dev", "cloudtest", "cloudXtest", "cloud_test_copy", "cloud_TEST"]) {
    expect(() => assertTestDatabase(name)).toThrow(/ends with "_test"/);
  }
  for (const name of ["cloud_test", "app_integration_test"]) expect(() => assertTestDatabase(name)).not.toThrow();
});

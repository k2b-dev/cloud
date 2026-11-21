import { expect, test } from "bun:test";
import { CODE_DATABASE_SETTINGS } from "./database-settings";

test("Core owns the RSQL connection and keeps the token secret without an environment override", () => {
  expect(CODE_DATABASE_SETTINGS["core.code.rsql_api_token"].kind).toBe("secret");
  expect(Object.values(CODE_DATABASE_SETTINGS).every((setting) => !("envVariable" in setting))).toBe(true);
  const validate = CODE_DATABASE_SETTINGS["core.code.rsql_url"].validate;
  for (const value of ["", "http://rsql:8080", "https://database.example/rsql"]) expect(validate(value)).toBeUndefined();
  for (const value of [
    123,
    "file:///data/database",
    "https://user:password@database.example",
    "https://database.example?token=secret",
    "https://database.example#fragment",
  ])
    expect(validate(value)).toBeDefined();
});

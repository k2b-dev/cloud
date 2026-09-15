import { describe, expect, test } from "bun:test";
import { configurePostgresApplicationName } from "./postgres-application-name";

const connectionUrl = "postgresql://fixture:fixture@localhost:5432/fixture?sslmode=require&connect_timeout=5";
const variables = ["DATABASE_URL", "DATABASEURL", "TLS_DATABASE_URL", "POSTGRES_URL", "PGURL", "PG_URL", "TLS_POSTGRES_DATABASE_URL"];

describe("Postgres application names", () => {
  test("sets the name on the selected URL while preserving connection settings", () => {
    const environment = { DATABASE_URL: connectionUrl };
    configurePostgresApplicationName("mail", environment);
    const url = new URL(environment.DATABASE_URL);
    expect(url.searchParams.get("application_name")).toBe("cloud:mail");
    url.searchParams.delete("application_name");
    expect(url.toString()).toBe(connectionUrl);
  });

  test("matches URL precedence without moving implicit TLS configuration to another variable", () => {
    for (let index = 0; index < variables.length; index++) {
      const remaining = variables.slice(index);
      const environment: Record<string, string> = Object.fromEntries(remaining.map((key) => [key, connectionUrl]));
      configurePostgresApplicationName("accounts", environment);
      expect(Object.keys(environment)).toEqual(remaining);
      for (const [key, value] of Object.entries(environment)) {
        expect(new URL(value).searchParams.get("application_name")).toBe(key === remaining[0] ? "cloud:accounts" : null);
      }
    }
  });

  test("preserves explicit operator names, empty names and startup options", () => {
    for (const parameter of [
      "application_name=operator",
      "application_name=",
      "APPLICATION_NAME=operator",
      "options=-c%20application_name%3Doperator",
      "options=-c%20statement_timeout%3D1000",
    ]) {
      const original = `${connectionUrl}&${parameter}`;
      const environment = { DATABASE_URL: original };
      configurePostgresApplicationName("mail", environment);
      expect(environment.DATABASE_URL).toBe(original);
    }
  });

  test("does not invent or replace missing, invalid or non-Postgres connection settings", () => {
    for (const environment of [
      {},
      { DATABASE_URL: "invalid", POSTGRES_URL: connectionUrl },
      { DATABASE_URL: "mysql://localhost/test" },
      { PGHOST: "localhost", PGDATABASE: "fixture" },
    ]) {
      const original = { ...environment };
      configurePostgresApplicationName("mail", environment);
      expect(environment).toEqual(original);
    }
  });

  test("leaves the first assigned application name stable across repeated definitions", () => {
    const environment = { DATABASE_URL: connectionUrl };
    configurePostgresApplicationName("mail", environment);
    configurePostgresApplicationName("mail", environment);
    configurePostgresApplicationName("another-app", environment);
    expect(new URL(environment.DATABASE_URL).searchParams.get("application_name")).toBe("cloud:mail");
  });
});

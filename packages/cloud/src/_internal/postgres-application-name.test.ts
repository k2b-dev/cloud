import { describe, expect, test } from "bun:test";
import { postgresApplicationOptions } from "./postgres-application-name";

const connectionUrl = "postgresql://fixture:fixture@localhost:5432/fixture?sslmode=require&connect_timeout=5";

describe("Postgres application names", () => {
  test("names connections without rewriting the operator URL", () => {
    expect(postgresApplicationOptions("mail", connectionUrl)).toEqual({ application_name: "cloud:mail" });
  });
  test("preserves operator names, empty names and startup options", () => {
    for (const parameter of [
      "application_name=operator",
      "application_name=",
      "APPLICATION_NAME=operator",
      "options=-c%20application_name%3Doperator",
      "options=-c%20statement_timeout%3D1000",
    ]) {
      expect(postgresApplicationOptions("mail", `${connectionUrl}&${parameter}`)).toEqual({});
    }
  });
});

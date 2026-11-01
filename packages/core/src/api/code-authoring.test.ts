import { expect, test } from "bun:test";
import { z } from "zod";
import { CodeDataError } from "../code/access";
import { codeAuthoringFailure, createCodeAuthoringRoutes } from "./code-authoring";

test("authoring routes construct with their OpenAPI response schemas", () => {
  const routes = createCodeAuthoringRoutes().routes;
  expect(routes.some((route) => route.path === "/check")).toBe(true);
  expect(routes.some((route) => route.path === "/activate")).toBe(true);
});
test("invalid service output remains a server error with no diagnostics in the public body", () => {
  const result = z.object({ version: z.literal(1) }).safeParse({ version: 2 });
  if (result.success) throw new Error("Expected invalid service output");
  for (const error of [result.error, new SyntaxError("private server details")]) {
    const failure = codeAuthoringFailure(error);
    expect(failure.status).toBe(500);
    expect(failure.body.error.code).toBe("code_authoring_failed");
    expect(failure.body.error.details).toBeNull();
    expect(JSON.stringify(failure.body)).not.toContain("private server details");
  }
  expect(codeAuthoringFailure(new CodeDataError("BAD_INPUT", "Invalid Code command input.")).status).toBe(400);
});

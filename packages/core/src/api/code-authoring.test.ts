import { expect, mock, spyOn, test } from "bun:test";
import { auth } from "@k2b/cloud/server";
import * as logging from "@k2b/cloud/services/logging";
import { z } from "zod";
import { CodeDataError } from "../code/access";
import { codeAuthoringContracts } from "../code/authoring-contracts";
import { codeAuthoringFailure, createCodeAuthoringRoutes } from "./code-authoring";

test("authoring routes construct with their OpenAPI response schemas", () => {
  const routes = createCodeAuthoringRoutes().routes;
  expect(routes.some((route) => route.path === "/check")).toBe(true);
  expect(routes.some((route) => route.path === "/activate")).toBe(true);
  for (const key of Object.keys(codeAuthoringContracts)) expect(routes.some((route) => route.path === `/${key}`)).toBe(true);
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

test("private secret failures never put secret-bearing exceptions in server logs or HTTP output", async () => {
  const privateValue = "fixture-private-server-credential";
  const errorLog = mock((_message: string, _metadata?: Record<string, unknown>) => {});
  const role = spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next());
  const scope = spyOn(auth, "requireOAuthScope").mockReturnValue(async (_c, next) => next());
  const authority = spyOn(auth, "getAuthority").mockImplementation(() => {
    throw new Error(privateValue);
  });
  const log = spyOn(logging, "logger").mockReturnValue({ error: errorLog, info: () => {}, warn: () => {}, debug: () => {} });
  try {
    const response = await createCodeAuthoringRoutes().request("/secretSet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codeId: "c_1234", name: "BANK_TOKEN", value: privateValue, binding_revision: null }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(privateValue);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateValue);
    expect(errorLog.mock.calls).toEqual([
      ["Code authoring command failed", { command: "secretSet", error: "private secret operation failed" }],
    ]);
  } finally {
    role.mockRestore();
    scope.mockRestore();
    authority.mockRestore();
    log.mockRestore();
  }
});

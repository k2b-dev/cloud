import { expect, test } from "bun:test";
import { RunnerCallError, RunnerCallResponseSchema } from "./runner-protocol";

test("an undeclared-origin refusal names only the canonical origin through the runner error", () => {
  const error = { code: "code_http_origin_undeclared", origin: "https://api.example:8443" };
  expect(RunnerCallResponseSchema.parse({ ok: false, error })).toEqual({ ok: false, error });
  expect(new RunnerCallError(error.code, error.origin).message).toBe("code_http_origin_undeclared: https://api.example:8443");
  for (const origin of ["https://api.example/path", "https://user:secret@api.example", "http://api.example", "https://*.example"])
    expect(RunnerCallResponseSchema.safeParse({ ok: false, error: { ...error, origin } }).success).toBe(false);
  expect(new RunnerCallError("code_access_removed").message).toBe("code_access_removed");
});

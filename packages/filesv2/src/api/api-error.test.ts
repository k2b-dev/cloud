import { expect, test } from "bun:test";
import { FilegateError } from "@k2b/filegate";
import { FilesError } from "../service";
import { apiError, describeError } from "./api-error";

test("each failing step keeps its own code: template, storage, coordination, and Cloud defects", () => {
  expect(apiError(new FilesError("template_missing", 503))).toEqual({ code: "template_missing", status: 503 });
  expect(apiError(new FilesError("operation_busy", 503))).toEqual({ code: "operation_busy", status: 503 });
  expect(apiError(new FilesError("path_conflict", 409))).toEqual({ code: "path_conflict", status: 409 });
  expect(apiError(new FilegateError(502, "http_error", "Bad Gateway"))).toEqual({ code: "unavailable", status: 503 });
  expect(apiError(new FilegateError(412, "precondition_failed", ""))).toEqual({ code: "write_conflict", status: 409 });
  expect(apiError(new FilegateError(403, "permission_denied", ""))).toEqual({ code: "forbidden", status: 403 });
  expect(apiError(new Error("Asset path escapes src/assets: templates/empty.odt"))).toEqual({ code: "internal", status: 500 });
  expect(apiError(new TypeError("fetch failed"))).toEqual({ code: "internal", status: 500 });
});

test("the log entry names the underlying cause", () => {
  const error = new FilesError("template_missing", 503, { cause: new Error("No template at /app/assets/templates/empty.odt") });
  expect(describeError(error)).toEqual({
    name: "FilesError",
    message: "template_missing",
    cause: { name: "Error", message: "No template at /app/assets/templates/empty.odt" },
  });
  expect(describeError(new FilegateError(502, "http_error", "Bad Gateway"))).toEqual({
    name: "FilegateError",
    message: "Bad Gateway",
    status: 502,
    filegateCode: "http_error",
  });
});

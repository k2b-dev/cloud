import { expect, mock, test } from "bun:test";
import * as cloudServer from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";
import { FilesError } from "./service/errors";

const pass: MiddlewareHandler = async (_c, next) => next();
mock.module("@k2b/cloud/server", () => ({
  ...cloudServer,
  auth: { ...cloudServer.auth, requireRole: () => pass },
  rateLimit: () => pass,
}));

let fail = false;
const seconds: number[] = [];
let calls = 0;
const commit = async () => {
  calls++;
  expect(seconds).toEqual([cloudServer.REQUEST_IDLE_TIMEOUT_MAX_SECONDS]);
  if (fail) throw new FilesError("upload_closed", 409);
  return { name: "file.txt" };
};
mock.module("./service", () => ({
  FilesError,
  EDITOR_DOCUMENT_LIMIT: 256 * 1024 * 1024,
  filesService: { commitUpload: commit, publicInboxCommit: commit },
}));

const { default: api } = await import("./api");
const { publicApi } = await import("./public");

for (const [app, path] of [
  [api, "/bases/home/uploads/session-id/commit"],
  [publicApi, "/inbox/token/api/uploads/session-id/commit"],
] as const) {
  test.each([false, true])(`${path} raises and restores the socket timeout (failure: %s)`, async (failure) => {
    fail = failure;
    calls = 0;
    seconds.length = 0;
    const response = await app.request(
      path,
      { method: "POST" },
      {
        timeout(_request: Request, value: number) {
          seconds.push(value);
        },
      },
    );
    expect(response.status).toBe(failure ? 409 : 200);
    expect(calls).toBe(1);
    expect(seconds).toEqual([cloudServer.REQUEST_IDLE_TIMEOUT_MAX_SECONDS, cloudServer.REQUEST_IDLE_TIMEOUT_SECONDS]);
    expect(seconds).toEqual([240, 10]);
  });
}

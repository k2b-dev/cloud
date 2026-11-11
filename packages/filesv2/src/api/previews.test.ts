import { afterEach, expect, spyOn, test } from "bun:test";
import { type AuthContext, getLocale, respond } from "@k2b/cloud/server";
import { Hono } from "hono";
import { testActor, testCall } from "../../test/files-call";
import { FilesError, filesService } from "../service";
import { errorMessage } from "./messages";
import { previewApi } from "./previews";

afterEach(() => {
  spyOn(filesService, "preview").mockRestore();
  spyOn(filesService, "retryPreview").mockRestore();
});
const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", testActor);
    c.set("accessSubject", testCall(testActor).accessSubject);
    c.set("credentialKind", "session");
    await next();
  })
  .onError((error, c) => {
    if (!(error instanceof FilesError)) throw error;
    return respond(c, { ok: false, error: errorMessage(error.code, getLocale(c)), code: error.code, status: error.status });
  })
  .route("/", previewApi);
const url = "/bases/base/preview?path=Docs%2Fplan.png&rev=r1&size=small";
test("ready bytes use the revision cache policy and pass the request signal", async () => {
  const read = spyOn(filesService, "preview").mockResolvedValue({
    result: { state: "ready", body: new Blob(["image"]), type: "image/jpeg", bytes: 5 },
    immutable: true,
  });
  const response = await app.request(url);
  expect(await response.text()).toBe("image");
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  // A cached preview belongs to the session that read it; another sign-in in the same browser asks again.
  expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(read.mock.calls[0]?.[1]).toEqual({ baseId: "base", path: "Docs/plan.png", rev: "r1", size: "small" });
  expect(read.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  read.mockResolvedValue({ result: { state: "ready", body: new Blob(["pdf"]), type: "application/pdf", bytes: 3 }, immutable: false });
  const pdf = await app.request(url);
  expect(pdf.headers.get("Cache-Control")).toBe("no-store");
  expect(pdf.headers.get("Content-Disposition")).toBe("inline");
});
test("pending and terminal states use exact JSON and no-store", async () => {
  const read = spyOn(filesService, "preview").mockResolvedValue({ result: { state: "pending", retryAfter: 2 }, immutable: true });
  const pending = await app.request(url);
  expect(pending.status).toBe(202);
  expect(await pending.json()).toEqual({ state: "pending" });
  expect(pending.headers.get("Retry-After")).toBe("2");
  expect(pending.headers.get("Cache-Control")).toBe("no-store");
  for (const state of ["failed", "too_large", "unsupported"] as const) {
    read.mockResolvedValue({ result: { state }, immutable: false });
    const result = await app.request(url);
    expect(result.status).toBe(404);
    expect(await result.json()).toMatchObject({ code: `preview_${state}` });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  }
});
test("retry is a read-authorized POST and access failures retain their status", async () => {
  const retry = spyOn(filesService, "retryPreview").mockResolvedValue({ state: "pending" });
  const response = await app.request("/bases/base/preview/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "Docs/plan.png" }),
  });
  expect(await response.json()).toEqual({ state: "pending" });
  expect(retry.mock.calls[0]?.[1]).toEqual({ baseId: "base", path: "Docs/plan.png" });
  spyOn(filesService, "preview").mockRejectedValue(new FilesError("forbidden", 403));
  expect((await app.request(url)).status).toBe(403);
});

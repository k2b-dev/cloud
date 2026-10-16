import { expect, spyOn, test } from "bun:test";
import { Filegate } from "@k2b/filegate";
import { filegateApiFetch, filegateCallTimeoutMs } from "./index";

const prefix = "https://filegate.test/v1/roots/cloud/uploads/sessions";
const slow = 10 * 60 * 1000;

test.each([
  ["POST", `${prefix}/session-id/commit`, slow],
  ["POST", `${prefix}/session-id/commit?receipt=true`, slow],
  ["GET", `${prefix}/session-id/commit`, 10_000],
  ["PUT", `${prefix}/session-id/commit`, 10_000],
  ["GET", `${prefix}/session-id`, 10_000],
  ["POST", prefix, 10_000],
  ["POST", `${prefix}/session-id/lease`, 10_000],
  ["PUT", "https://filegate.test/v1/direct/lease?segment=0", 10_000],
  ["POST", `${prefix}/session-id/commit/extra`, 10_000],
  ["POST", `${prefix}/nested/session-id/commit`, 10_000],
  ["POST", `${prefix}//commit`, 10_000],
  ["POST", `https://filegate.test/v1/other?path=/uploads/sessions/id/commit`, 10_000],
  ["DELETE", "https://filegate.test/v1/roots/cloud/entries", slow],
  ["POST", "https://filegate.test/v1/roots/cloud/transfers?path=folder", slow],
  ["POST", "https://filegate.test/v1/roots/cloud/transfers/extra", 10_000],
] as const)("%s %s gets %i ms", (method, url, expected) => {
  expect(filegateCallTimeoutMs(url, { method })).toBe(expected);
  expect(filegateCallTimeoutMs(new URL(url), { method })).toBe(expected);
  expect(filegateCallTimeoutMs(new Request(url, { method }))).toBe(expected);
});

test("the real SDK commit uses the slow budget and the wrapper preserves explicit signals and preconnect", async () => {
  const deadlines: number[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal });
      return Response.json({ path: "file.txt" });
    },
    { preconnect: fetch.preconnect },
  );
  try {
    const wrapped = filegateApiFetch(transport);
    await new Filegate({ baseUrl: "https://filegate.test", token: "test", fetch: wrapped }).root("cloud").commitSession("session-id");
    expect(calls[0]?.url).toBe(`${prefix}/session-id/commit`);
    expect(deadlines).toEqual([slow]);
    const signal = new AbortController().signal;
    await wrapped(`${prefix}/session-id/commit`, { method: "POST", signal });
    expect(calls[1]?.signal).toBe(signal);
    expect(deadlines).toEqual([slow]);
    expect(wrapped.preconnect).toBe(transport.preconnect);
  } finally {
    timeout.mockRestore();
  }
});

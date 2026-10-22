import { expect, spyOn, test } from "bun:test";
import { Filegate } from "@k2b/filegate";
import { filegateApiFetch, filegateCallTimeoutMs } from "./filegate-facade";

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
  const calls: { url: string; signal: AbortSignal | null | undefined; idle: number | boolean | undefined }[] = [];
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      calls.push({ url: String(input), signal: init?.signal, idle: init?.timeout });
      return Response.json({ path: "file.txt" });
    },
    { preconnect: fetch.preconnect },
  );
  try {
    const wrapped = filegateApiFetch(transport);
    await new Filegate({ baseUrl: "https://filegate.test", token: "test", fetch: wrapped }).root("cloud").commitSession("session-id");
    expect(calls[0]?.url).toBe(`${prefix}/session-id/commit`);
    // Bun's socket idle timer must not end the commit before its budget.
    expect(calls[0]?.idle).toBe(slow);
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

test("history request cancellation reaches info/stat/ACL/resolve on derived SDK clients", async () => {
  const { connectFilegate } = await import("./filegate-facade");
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const transport: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!init?.signal) throw new Error("Missing request cancellation");
      seen.push(init.signal);
      return Response.json({ entries: [] });
    },
    { preconnect: fetch.preconnect },
  );
  const root = connectFilegate({ url: "https://filegate.test", token: "test" }, transport, controller.signal)
    .as({ uid: 1000, gid: 1000 })
    .root("freeipa")
    .as({ uid: 1000, gid: 1000 });
  await root.info();
  await root.stat("private.txt");
  await root.getACL("private.txt", "access");
  await root.resolve("stable-id");
  expect(seen).toHaveLength(4);
  controller.abort(new Error("history canceled"));
  expect(seen.every((signal) => signal.aborted)).toBe(true);
  await expect(root.stat("must-not-start")).rejects.toThrow("history canceled");
  expect(seen).toHaveLength(4);
});

test("aborting an in-flight history SDK read rejects its transport rather than leaving a background request", async () => {
  const { connectFilegate } = await import("./filegate-facade");
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let active = 0;
  const transport: typeof fetch = Object.assign(
    (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (!init?.signal) throw new Error("Missing request signal");
        active++;
        init.signal.addEventListener(
          "abort",
          () => {
            active--;
            reject(init.signal!.reason);
          },
          { once: true },
        );
        started();
      }),
    { preconnect: fetch.preconnect },
  );
  const pending = connectFilegate({ url: "https://filegate.test", token: "test" }, transport, controller.signal)
    .root("cloud")
    .stat("file.txt");
  const outcome = pending.then(
    () => null,
    (error: unknown) => error,
  );
  await ready;
  expect(active).toBe(1);
  controller.abort(new Error("read canceled"));
  expect(await outcome).toMatchObject({ message: "read canceled" });
  expect(active).toBe(0);
});

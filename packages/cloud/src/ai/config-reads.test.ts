import { expect, test } from "bun:test";
import { Hono } from "hono";
import { aiConfigRequestScope, readAiConfigOnce } from "./config-reads";

const counter = () => {
  let reads = 0;
  return {
    read: async () => ({ reads: ++reads }),
    count: () => reads,
  };
};

test("outside a request every caller reads", async () => {
  const source = counter();
  await readAiConfigOnce("key", source.read);
  await readAiConfigOnce("key", source.read);
  expect(source.count()).toBe(2);
});

test("a GET reads a key once while it builds its response, and a streamed body afterwards reads fresh", async () => {
  const source = counter();
  let later: (() => Promise<unknown>) | undefined;
  const app = new Hono().use("*", aiConfigRequestScope).get("/", async (c) => {
    const [first, second] = await Promise.all([readAiConfigOnce("key", source.read), readAiConfigOnce("key", source.read)]);
    expect(second).toBe(first);
    // Work the response starts and that runs after it is built, such as a stream's body.
    later = () => readAiConfigOnce("key", source.read);
    return c.body(null, 204);
  });
  expect((await app.request("/")).status).toBe(204);
  expect(source.count()).toBe(1);
  await later?.();
  expect(source.count()).toBe(2);
});

test("a failed read is not kept: the next caller of the same request tries again", async () => {
  let attempts = 0;
  const app = new Hono().use("*", aiConfigRequestScope).get("/", async (c) => {
    const failing = () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("down")) : Promise.resolve("ok");
    };
    await expect(readAiConfigOnce("key", failing)).rejects.toThrow("down");
    expect(await readAiConfigOnce("key", failing)).toBe("ok");
    return c.body(null, 204);
  });
  expect((await app.request("/")).status).toBe(204);
  expect(attempts).toBe(2);
});

test("requests at the same time keep their own reads", async () => {
  const source = counter();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = new Hono().use("*", aiConfigRequestScope).get("/", async (c) => {
    await readAiConfigOnce("key", source.read);
    await gate;
    await readAiConfigOnce("key", source.read);
    return c.body(null, 204);
  });
  const both = Promise.all([app.request("/"), app.request("/")]);
  release();
  expect((await both).map((response) => response.status)).toEqual([204, 204]);
  expect(source.count()).toBe(2);
});

test("the answer is frozen all the way down, in a request and outside one", async () => {
  const read = async () => ({ rules: [{ scope: "*", limits: { day: 1 } }] });
  const outside = await readAiConfigOnce("key", read);
  let inside: Awaited<ReturnType<typeof read>> | undefined;
  const app = new Hono().use("*", aiConfigRequestScope).get("/", async (c) => {
    inside = await readAiConfigOnce("key", read);
    return c.body(null, 204);
  });
  expect((await app.request("/")).status).toBe(204);
  for (const answer of [outside, inside!]) {
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(answer.rules)).toBe(true);
    expect(Object.isFrozen(answer.rules[0]!.limits)).toBe(true);
  }
});

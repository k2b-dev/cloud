import { expect, spyOn, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { anchor, digestPlan, planLargeMailbox } from "./large-mailbox";

const parameters = { seed: 20261001, anchor, messages: 20000, conversations: 3000, folders: 30 };

test("mailbox planning is deterministic and does not consult time or system randomness", () => {
  const originalDate = globalThis.Date;
  const forbidden = () => {
    throw new Error("Uncontrolled randomness/time");
  };
  const random = spyOn(Math, "random").mockImplementation(forbidden);
  const now = spyOn(Date, "now").mockImplementation(forbidden);
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(forbidden);
  globalThis.Date = new Proxy(originalDate, {
    construct(target, args, newTarget) {
      if (!args.length) forbidden();
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const a = planLargeMailbox(parameters),
      b = planLargeMailbox({ ...parameters });
    expect(digestPlan(a)).toBe(digestPlan(b));
    expect(a.bodyCorpus).toBe(b.bodyCorpus);
    expect(digestPlan({ ...a, bodyCorpus: `X${a.bodyCorpus.slice(1)}` })).not.toBe(digestPlan(a));
    expect(digestPlan(planLargeMailbox({ ...parameters, seed: 42 }))).not.toBe(digestPlan(a));
    expect(digestPlan(planLargeMailbox({ ...parameters, anchor: "2025-10-01T00:00:00Z" }))).not.toBe(digestPlan(a));
  } finally {
    globalThis.Date = originalDate;
    uuid.mockRestore();
    now.mockRestore();
    random.mockRestore();
  }
});
test("corpus bodies preserve byte sizes, search prefixes and wraparound without extreme Brotli compression", () => {
  const p = planLargeMailbox(parameters);
  expect(p.bodyCorpus.length).toBe(256 * 1024);
  expect(p.bodyCorpus).toMatch(/^[A-Za-z.\s]+$/);
  expect(p.bodyCorpus).toContain(".\n\n");
  expect(p.bodyCorpus.toLowerCase()).not.toContain(p.shape.rareWord);
  expect(p.bodyCorpus.toLowerCase()).not.toContain(p.shape.commonWord);
  const doubled = p.bodyCorpus.repeat(2);
  // Mirrors perf_corpus + perf_bodies: PostgreSQL substring is 1-based.
  const body = (message: (typeof p.messages)[number]) => {
    const length = message.bodyBytes - message.text.length - (message.html ? 7 : 0);
    const plain = message.text + doubled.slice(message.bodyOffset, message.bodyOffset + length);
    return message.html ? `<p>${plain}</p>` : plain;
  };
  let rareMessages = 0;
  let commonMessages = 0;
  for (const message of p.messages) {
    expect(message.bodyOffset).toBeGreaterThanOrEqual(0);
    expect(message.bodyOffset).toBeLessThan(p.bodyCorpus.length);
    const sample = body(message);
    expect(Buffer.byteLength(sample)).toBe(message.bodyBytes);
    expect(sample.startsWith((message.html ? "<p>" : "") + message.text)).toBe(true);
    if (sample.includes(p.shape.rareWord)) rareMessages++;
    if (sample.includes(p.shape.commonWord)) commonMessages++;
  }
  expect(rareMessages).toBe(1);
  expect(commonMessages).toBe(parameters.messages - 1);
  const message = p.messages[0]!;
  const offset = p.bodyCorpus.length - 10;
  const wrapped = body({ ...message, html: false, bodyBytes: message.text.length + 30, bodyOffset: offset });
  expect(wrapped).toBe(message.text + p.bodyCorpus.slice(-10) + p.bodyCorpus.slice(0, 20));
  for (const html of [false, true]) {
    const sample = body({ ...message, html, bodyBytes: 50 * 1024, bodyOffset: offset });
    expect(Buffer.byteLength(sample)).toBe(50 * 1024);
    expect(Buffer.byteLength(sample) / brotliCompressSync(sample).length).toBeLessThan(8);
  }
});
test("declared mailbox shape covers all rows and production-sized skew", () => {
  const p = planLargeMailbox(parameters);
  expect(p.messages).toHaveLength(parameters.messages);
  expect(p.conversations).toHaveLength(parameters.conversations);
  expect(p.folders).toHaveLength(parameters.folders);
  expect(p.conversations.filter((c) => c.size > 100)).toHaveLength(1);
  expect(p.conversations.filter((c) => c.size >= 50 && c.size <= 100).length).toBeGreaterThan(2);
  expect(p.shape.threadSizeHistogram["1-3"]!).toBeGreaterThan(parameters.conversations * 0.6);
  const histogram = p.shape.threadSizeHistogram;
  expect(histogram["1-3"]).toBe(parameters.conversations * 0.7);
  for (const n of Object.values(histogram)) expect(n).toBeGreaterThan(0);
  expect(histogram["4-9"]!).toBeGreaterThan(histogram["10-49"]!);
  expect(histogram["10-49"]!).toBeGreaterThan(histogram["50-100"]!);
  expect(histogram[">100"]).toBe(1);
  expect(histogram).toMatchInlineSnapshot(`
    {
      "1-3": 2100,
      "10-49": 413,
      "4-9": 422,
      "50-100": 64,
      ">100": 1,
    }
  `);
  expect(p.conversations[0]!.size).toBeGreaterThanOrEqual(150);
  expect(p.conversations[0]!.size).toBeLessThanOrEqual(200);
  for (const [n, fraction] of [
    [p.shape.unread, 0.05],
    [p.shape.html, 0.3],
    [p.shape.attachments, 0.1],
  ])
    expect(Math.abs(n! / parameters.messages - fraction!)).toBeLessThan(0.015);
  expect(Object.values(p.shape.totals).reduce((n, f) => n + f.total, 0)).toBe(parameters.messages);
  expect(Object.values(p.shape.totals).reduce((n, f) => n + f.unread, 0)).toBe(p.shape.unread);
  expect(p.messages.filter((m) => m.text.includes(p.shape.rareWord))).toHaveLength(1);
  expect(p.messages.filter((m) => m.text.includes(p.shape.commonWord)).length).toBeGreaterThan(parameters.messages * 0.9);
  expect(new Set(p.messages.map((m) => m.id)).size).toBe(parameters.messages);
  for (const m of p.messages) {
    expect(m.id).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/);
    expect(Date.parse(m.date)).toBeLessThan(Date.parse(anchor));
    if (m.html) {
      expect(m.bodyBytes).toBeGreaterThanOrEqual(2048);
      expect(m.bodyBytes).toBeLessThanOrEqual(50 * 1024);
    }
  }
  const sparse = p.shape.totals[p.shape.sparseOldFolderId]!;
  expect(sparse.total).toBeLessThan(5);
});
test("conversation dates advance in realistic gaps from starts spread across the frozen history", () => {
  const p = planLargeMailbox(parameters);
  const day = 86400_000;
  const cutoff = Date.parse(parameters.anchor) - day;
  const dates = new Map<string, number[]>();
  for (const m of p.messages) {
    const date = Date.parse(m.date);
    expect(date).toBeLessThan(cutoff);
    const thread = dates.get(m.conversation) ?? [];
    thread.push(date);
    dates.set(m.conversation, thread);
    if (m.folder === p.shape.sparseOldFolderId) {
      expect(cutoff - date).toBeGreaterThan(1090 * day);
      expect(cutoff - date).toBeLessThanOrEqual(1094 * day);
    }
  }
  const starts = [...dates.values()].map((thread) => thread[0]!);
  expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan(1090 * day);
  expect(starts.filter((start) => cutoff - start < 365 * day).length).toBeGreaterThan(starts.length / 2);
  for (const thread of dates.values()) {
    for (let j = 1; j < thread.length; j++) {
      const gap = thread[j]! - thread[j - 1]!;
      expect(gap).toBeGreaterThanOrEqual(60_000);
      expect(gap).toBeLessThanOrEqual(2 * day + 60_000);
    }
    expect(thread.at(-1)! - thread[0]!).toBeLessThan(60 * day);
  }
  const long = dates.get(p.shape.largestThreadId)!;
  expect(long.at(-1)! - long[0]!).toBeGreaterThan(14 * day);
});
test("small, sparse and dense requested shapes preserve exact sizes", () => {
  for (const [messages, conversations, folders] of [
    [1, 1, 6],
    [600, 120, 6],
    [1000, 1000, 350],
    [10000, 5, 6],
    [100000, 1, 6],
    [100000, 1000, 6],
  ]) {
    const p = planLargeMailbox({ ...parameters, messages: messages!, conversations: conversations!, folders: folders! });
    expect(p.messages).toHaveLength(messages!);
    expect(p.conversations).toHaveLength(conversations!);
    expect(p.conversations.reduce((n, c) => n + c.size, 0)).toBe(messages!);
    expect(p.folders).toHaveLength(folders!);
    expect(p.conversations.filter((c) => c.size > 100).length).toBeLessThanOrEqual(1);
    expect(p.conversations.some((c) => c.status === "done" && c.snoozedUntil !== null)).toBe(false);
    if (conversations! > 1) expect(p.shape.totals[p.shape.sparseOldFolderId]!.total).toBeGreaterThan(0);
    for (const m of p.messages) expect(Date.parse(m.date)).toBeLessThan(Date.parse(parameters.anchor) - 86400_000);
    for (const [i, f] of p.folders.entries()) if (f.parent !== null) expect(f.parent).toBeLessThan(i);
  }
});
test("the body corpus is ASCII, so seeding can slice it by byte offset", () => {
  expect(planLargeMailbox(parameters).bodyCorpus).toMatch(/^[\x20-\x7e\n]*$/);
});

import { expect, test } from "bun:test";
import { boundedSettlement, matchPageChangeTransfers, webkitTransferBytes } from "./page-change-network";

test("each frozen request consumes one CDP transfer, excluding unrelated late starts", () => {
  const url = "https://localhost/entry.js";
  const first = { url, bytes: 100 };
  const second = { url, bytes: 200 };
  const extra = { url: "https://localhost/late.js", bytes: 300 };
  expect(matchPageChangeTransfers([url, url], [first, extra, second])).toEqual([first, second]);
  expect(() => matchPageChangeTransfers([url, url], [first, extra])).toThrow("Missing page-change CDP request: /entry.js");
});

test("cached response header estimates cannot fabricate a positive transfer", () => {
  expect(webkitTransferBytes({ responseBodySize: -340, responseHeadersSize: 340 })).toBe(0);
  expect(webkitTransferBytes({ responseBodySize: 1000, responseHeadersSize: 340 })).toBe(1340);
});

test("settlement includes a request that finishes after the measurement window closes", async () => {
  let finish!: (value: number) => void;
  const jobs = [
    Promise.resolve(100),
    new Promise<number>((resolve) => {
      finish = resolve;
    }),
  ];
  let complete = false;
  const result = boundedSettlement(jobs, 1000).then((values) => {
    complete = true;
    return values;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  finish(200);
  expect(await result).toEqual([100, 200]);
});

test("an outstanding required request fails visibly instead of contributing zero bytes", async () => {
  await expect(boundedSettlement([new Promise<never>(() => {})], 1)).rejects.toThrow("did not settle");
});

import { expect, mock, test } from "bun:test";
import { EXPORT_PAGE_SIZE, exportPages } from "../service/contacts";
import type { Contact } from "../service/types";
import { exportBody } from "./export-stream";

const config = () => ({ bookId: "00000000-0000-4000-8000-000000000001", format: "csv" as const, signal: new AbortController().signal });

test("writes the header exactly once and pulls only when read", async () => {
  let calls = 0;
  async function* pages(): AsyncGenerator<Contact[]> {
    calls++;
    yield [];
    calls++;
    yield [];
  }
  const reader = exportBody(pages, () => "row\r\n", { ...config(), header: "header\r\n" }).getReader();
  const decoder = new TextDecoder();
  expect(calls).toBe(0);
  expect(decoder.decode((await reader.read()).value)).toBe("header\r\n");
  expect(calls).toBe(0);
  expect(decoder.decode((await reader.read()).value)).toBe("row\r\n");
  expect(calls).toBe(1);
  expect(decoder.decode((await reader.read()).value)).toBe("row\r\n");
  expect(calls).toBe(2);
  expect((await reader.read()).done).toBe(true);
});

test("a mid-stream page failure rejects the response body", async () => {
  const failure = new Error("Page query failed");
  async function* pages(): AsyncGenerator<Contact[]> {
    yield [];
    throw failure;
  }
  const logError = mock(() => {});
  const options = config();
  const stream = exportBody(pages, () => "first page\r\n", options, logError);
  await expect(new Response(stream).text()).rejects.toBe(failure);
  expect(logError).toHaveBeenCalledTimes(1);
  expect(logError).toHaveBeenCalledWith("Contacts export failed", { bookId: options.bookId, format: "csv", error: failure.message });
});

test("consumer cancel returns the generator without loading another page", async () => {
  let loads = 0;
  let returned = false;
  async function* pages(): AsyncGenerator<Contact[]> {
    try {
      loads++;
      yield [];
      loads++;
      yield [];
    } finally {
      returned = true;
    }
  }
  const reader = exportBody(pages, () => "page", config()).getReader();
  await reader.read();
  await reader.cancel("Download cancelled");
  expect(returned).toBe(true);
  expect(loads).toBe(1);
});

test("request abort prevents further reads and serialization", async () => {
  const controller = new AbortController();
  const logError = mock(() => {});
  let loads = 0;
  let serialized = 0;
  async function* pages(): AsyncGenerator<Contact[]> {
    loads++;
    yield [];
    loads++;
    yield [];
  }
  const reader = exportBody(pages, () => String(++serialized), { ...config(), signal: controller.signal }, logError).getReader();
  await reader.read();
  const reason = new Error("Client disconnected");
  controller.abort(reason);
  await expect(reader.read()).rejects.toBe(reason);
  expect(loads).toBe(1);
  expect(serialized).toBe(1);
  expect(logError).not.toHaveBeenCalled();
});

test("cancel during an empty full page load prevents the next query", async () => {
  const options = config();
  const loaded = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let loads = 0;
  let returned = false;
  async function* pages(signal: AbortSignal): AsyncGenerator<Contact[]> {
    try {
      yield* exportPages({ bookId: options.bookId, signal }, async () => {
        loads++;
        loaded.resolve();
        await release.promise;
        return { ids: Array.from({ length: EXPORT_PAGE_SIZE }, (_, i) => String(i)), contacts: new Map<string, Contact>() };
      });
    } finally {
      returned = true;
    }
  }
  const reader = exportBody(pages, () => "page", options).getReader();
  const reading = reader.read();
  await loaded.promise;
  const cancelling = reader.cancel("Download cancelled");
  release.resolve();
  await cancelling;
  expect((await reading).done).toBe(true);
  expect(loads).toBe(1);
  expect(returned).toBe(true);
});

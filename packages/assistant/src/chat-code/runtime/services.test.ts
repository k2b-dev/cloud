import { afterEach, expect, jest, test } from "bun:test";
import { LIMITS } from "../contracts";
import { createServiceCalls } from "./services";
import { type RuntimeStream, runStream } from "./streams";

const NOW = Date.UTC(2030, 0, 2);
const metadata = { name: "invoice.pdf", mediaType: "application/pdf", size: 5 };
const signal = () => new AbortController().signal;
afterEach(() => jest.useRealTimers());

function fixture() {
  jest.setSystemTime(NOW);
  let index = 0;
  const offer = (direction: "read" | "write"): RuntimeStream => ({
    ...metadata,
    id: `${direction}-${++index}`,
    direction,
    callId: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date(NOW + 60_000).toISOString(),
  });
  let read = offer("read");
  let write = offer("write");
  const capability = jest.fn(async (name: string, _input: unknown, _signal: AbortSignal) => ({
    data: name === "read" ? metadata : { imported: false },
    stream: name === "read" ? read : write,
  }));
  const stream = jest.fn(async (_ref: RuntimeStream, verb: string, _body: Blob | undefined, _signal: AbortSignal) =>
    verb === "read" ? new File([new Uint8Array([0, 255, 37, 80, 10])], metadata.name) : { data: { imported: true } },
  );
  const call = createServiceCalls({ capability, stream });
  const sdkRead = () => call("capabilities.run", ["read", {}, undefined, "read"], signal());
  const sdkWrite = (file: unknown, stopped = signal()) => call("capabilities.run", ["write", { file }, undefined, "write"], stopped);
  return {
    call,
    sdkRead,
    sdkWrite,
    capability,
    stream,
    read: () => read,
    write: () => write,
    setRead: (patch: Partial<RuntimeStream>) => {
      read = { ...read, ...patch };
    },
    setWrite: (patch: Partial<RuntimeStream>) => {
      write = { ...write, ...patch };
    },
    file: () => ({ id: read.id, ...metadata }),
  };
}

test("raw capability envelopes retain their stream and ordinary data", async () => {
  const f = fixture();
  expect(await f.call("capabilities.run", ["read", {}], signal())).toEqual({ data: metadata, stream: f.read() });
  expect(f.stream).not.toHaveBeenCalled();
});

test("SDK refs must belong to this run and preserve their metadata", async () => {
  const f = fixture();
  const foreign = fixture();
  await f.sdkRead();
  for (const file of [
    { ...f.file(), id: "forged" },
    { ...f.file(), size: 4 },
    { ...f.file(), name: "other.pdf" },
    { ...f.file(), mediaType: "text/plain" },
  ])
    await expect(f.sdkWrite(file)).rejects.toMatchObject({ code: "denied" });
  await expect(foreign.sdkWrite(f.file())).rejects.toMatchObject({ code: "denied" });
  expect(f.capability).toHaveBeenCalledTimes(1);
  expect(foreign.capability).not.toHaveBeenCalled();
  expect(f.stream).not.toHaveBeenCalled();
});

test("SDK write refs cannot serve as file inputs, and expired reads cannot be redeemed", async () => {
  const f = fixture();
  await f.call("capabilities.run", ["write", {}], signal());
  await expect(f.sdkWrite({ id: f.write().id, ...metadata })).rejects.toMatchObject({ code: "denied" });
  await f.sdkRead();
  jest.setSystemTime(NOW + 60_000);
  await expect(f.sdkWrite(f.file())).rejects.toMatchObject({ code: "denied" });
  expect(f.capability).toHaveBeenCalledTimes(2);
  expect(f.stream).not.toHaveBeenCalled();
});

test.each(["direction", "size", "mediaType", "expiresAt"])("a mismatched write offer (%s) never transfers", async (field) => {
  const f = fixture();
  await f.sdkRead();
  const patches: Record<string, Partial<RuntimeStream>> = {
    direction: { direction: "read" },
    size: { size: 4 },
    mediaType: { mediaType: "text/plain" },
    expiresAt: { expiresAt: new Date(NOW).toISOString() },
  };
  f.setWrite(patches[field]!);
  await expect(f.sdkWrite(f.file())).rejects.toThrow();
  expect(f.stream).not.toHaveBeenCalled();
});

test("redemption is reserved before preparation, including concurrent calls and successful writes", async () => {
  const f = fixture();
  await f.sdkRead();
  const first = f.sdkWrite(f.file());
  await expect(f.sdkWrite(f.file())).rejects.toMatchObject({ code: "denied" });
  expect(await first).toEqual({ data: { imported: true } });
  await expect(f.sdkWrite(f.file())).rejects.toMatchObject({ code: "denied" });
  expect(f.capability).toHaveBeenCalledTimes(2);
  expect(f.stream).toHaveBeenCalledTimes(2);
});

test("an uncertain upload never retries or makes its file ref reusable", async () => {
  const f = fixture();
  await f.sdkRead();
  f.stream.mockImplementation(async (_ref, verb) => {
    if (verb === "write") throw new Error("Inspect upload status before retrying");
    return new File(["12345"], metadata.name);
  });
  await expect(f.sdkWrite(f.file())).rejects.toThrow("Inspect upload status");
  await expect(f.sdkWrite(f.file())).rejects.toMatchObject({ code: "denied" });
  expect(f.capability).toHaveBeenCalledTimes(2);
  expect(f.stream).toHaveBeenCalledTimes(2);
});

test("cancellation during the source read prevents the upload", async () => {
  const f = fixture();
  await f.sdkRead();
  const stopped = new AbortController();
  f.stream.mockImplementation(async () => {
    stopped.abort(new Error("Fixture cancellation"));
    return new File(["12345"], metadata.name);
  });
  await expect(f.sdkWrite(f.file(), stopped.signal)).rejects.toThrow("Fixture cancellation");
  expect(f.stream).toHaveBeenCalledTimes(1);
});

test("file and aggregate transfer budgets are checked before starting transfers", async () => {
  const oversized = fixture();
  oversized.setRead({ size: LIMITS.inputFileBytes + 1 });
  await expect(oversized.sdkRead()).rejects.toMatchObject({ code: "limit" });
  const f = fixture();
  f.stream.mockRejectedValue(new Error("Fixture read interruption"));
  for (let index = 0; index < 3; index++) {
    f.setRead({ id: `large-${index}`, size: LIMITS.inputFileBytes });
    f.setWrite({ size: LIMITS.inputFileBytes });
    await f.sdkRead();
    const write = f.sdkWrite({ ...f.file(), size: LIMITS.inputFileBytes });
    if (index < 2) await expect(write).rejects.toThrow("Fixture read interruption");
    else await expect(write).rejects.toMatchObject({ code: "limit" });
  }
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(f.capability).toHaveBeenCalledTimes(5);
});

test.each([4, 6])("the actual stream reader rejects a %s-byte body for a five-byte offer", async (size) => {
  const f = fixture();
  await expect(runStream(f.read(), "read", undefined, signal(), async () => new Response(new Uint8Array(size)))).rejects.toThrow();
});

test("a short source cannot start the write, and missing offers do not return preparation data", async () => {
  const f = fixture();
  await f.sdkRead();
  f.stream.mockResolvedValue(new File(["1234"], metadata.name));
  await expect(f.sdkWrite(f.file())).rejects.toMatchObject({ code: "invalid" });
  expect(f.stream).toHaveBeenCalledTimes(1);
  const missing = createServiceCalls({ capability: async () => ({ data: { imported: false } }) });
  await expect(missing("capabilities.run", ["read", {}, undefined, "read"], signal())).rejects.toMatchObject({ code: "unavailable" });
});

test("a destination may choose a different upload name without changing the source ref", async () => {
  const f = fixture();
  await f.sdkRead();
  f.setWrite({ name: "stored-invoice.pdf" });
  expect(await f.sdkWrite(f.file())).toEqual({ data: { imported: true } });
  expect(f.stream.mock.calls[0]?.[0].name).toBe("invoice.pdf");
  expect(f.stream.mock.calls[1]?.[0].name).toBe("stored-invoice.pdf");
});

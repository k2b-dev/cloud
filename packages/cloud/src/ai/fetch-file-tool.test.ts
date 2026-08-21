import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { aiFileStore } from "./files-store";
import {
  buildPinnedFetchFileRequestOptions,
  CloudAiFetchFileInputSchema,
  downloadPublicFile,
  runCloudAiFetchFile,
} from "./fetch-file-tool";

const publicAddress = { address: "203.0.114.10", family: 4 as const };

const fakeRequest = (response: { statusCode?: number; headers?: Record<string, string>; chunks?: Array<Uint8Array | string> }) =>
  ((_options: unknown, callback: (incoming: IncomingMessage) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => void;
    };
    outgoing.end = () => {
      queueMicrotask(() => {
        const incoming = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          resume: () => void;
          destroy: () => void;
        };
        incoming.statusCode = response.statusCode ?? 200;
        incoming.headers = response.headers ?? {};
        incoming.resume = () => undefined;
        incoming.destroy = () => undefined;
        callback(incoming as unknown as IncomingMessage);
        for (const chunk of response.chunks ?? []) incoming.emit("data", chunk);
        incoming.emit("end");
      });
    };
    outgoing.destroy = (error) => queueMicrotask(() => outgoing.emit("error", error ?? new Error("destroyed")));
    return outgoing as unknown as ClientRequest;
  }) as never;

describe("fetch_file AI tool", () => {
  test("pins HTTPS requests to bounded resolved addresses without forwarding credentials", () => {
    const requests = buildPinnedFetchFileRequestOptions(new URL("https://files.example:8443/report.pdf?rev=2"), [
      publicAddress,
      publicAddress,
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      protocol: "https:",
      hostname: publicAddress.address,
      port: 8443,
      path: "/report.pdf?rev=2",
      method: "GET",
      servername: "files.example",
      rejectUnauthorized: true,
      headers: {
        accept: "*/*",
        "accept-encoding": "identity",
        host: "files.example:8443",
      },
    });
    expect(JSON.stringify(requests)).not.toContain("authorization");
    expect(JSON.stringify(requests)).not.toContain("cookie");
  });

  test("rejects non-HTTPS and credential-bearing URLs before resolution", async () => {
    let resolutions = 0;
    const resolve = async () => {
      resolutions += 1;
      return [publicAddress];
    };

    await expect(downloadPublicFile("http://files.example/report.pdf", { resolve })).rejects.toThrow("HTTPS");
    await expect(downloadPublicFile("https://user:secret@files.example/report.pdf", { resolve })).rejects.toThrow("credentials");
    expect(resolutions).toBe(0);
  });

  test("revalidates every redirect and returns only the final response", async () => {
    const resolved: string[] = [];
    const requested: string[] = [];
    const result = await downloadPublicFile("https://files.example/start", {
      resolve: async (hostname) => {
        resolved.push(hostname);
        return [publicAddress];
      },
      requestPublicFile: async (url) => {
        requested.push(url.toString());
        return url.hostname === "files.example"
          ? { statusCode: 302, headers: { location: "https://cdn.example/report.pdf" }, bytes: new Uint8Array() }
          : {
              statusCode: 200,
              headers: { "content-type": "application/pdf" },
              bytes: new TextEncoder().encode("report"),
            };
      },
    });

    expect(resolved).toEqual(["files.example", "cdn.example"]);
    expect(requested).toEqual(["https://files.example/start", "https://cdn.example/report.pdf"]);
    expect(result.url.toString()).toBe("https://cdn.example/report.pdf");
    expect(new TextDecoder().decode(result.bytes)).toBe("report");
  });

  test("rejects redirect loops and unsafe redirect targets through the resolver", async () => {
    await expect(
      downloadPublicFile("https://files.example/start", {
        resolve: async (hostname) => {
          if (hostname === "internal.example") throw new Error("Network target resolved to a private or reserved address");
          return [publicAddress];
        },
        requestPublicFile: async () => ({
          statusCode: 302,
          headers: { location: "https://internal.example/secret" },
          bytes: new Uint8Array(),
        }),
      }),
    ).rejects.toThrow("File access blocked");

    await expect(
      downloadPublicFile("https://files.example/loop", {
        resolve: async () => [publicAddress],
        requestPublicFile: async (url) => ({ statusCode: 302, headers: { location: url.toString() }, bytes: new Uint8Array() }),
      }),
    ).rejects.toThrow("Too many file redirects");
  });

  test.each([
    [401, "Authorization required — This file may require an account or a signed-in session."],
    [403, "Access denied — This file may require an account or permission from its owner."],
    [404, "File not found — The linked file does not exist or is no longer available."],
    [410, "File not found — The linked file does not exist or is no longer available."],
    [429, "File server is busy — The server is rate-limiting downloads. Try again later."],
    [503, "File server error — The server returned HTTP 503. Try again later."],
  ])("explains HTTP %i failures", async (statusCode, message) => {
    await expect(
      downloadPublicFile("https://files.example/report.pdf", {
        resolve: async () => [publicAddress],
        request: fakeRequest({ statusCode }),
      }),
    ).rejects.toThrow(message);
  });

  test("distinguishes blocked and unresolved hosts", async () => {
    await expect(
      downloadPublicFile("https://internal.example/report.pdf", {
        resolve: async () => {
          throw new Error("Network target resolved to a private or reserved address");
        },
      }),
    ).rejects.toThrow("File access blocked");

    await expect(
      downloadPublicFile("https://missing.example/report.pdf", {
        resolve: async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
        },
      }),
    ).rejects.toThrow("File server not found");
  });

  test("keeps timeout and invalid redirect failures actionable", async () => {
    await expect(
      downloadPublicFile("https://files.example/report.pdf", {
        resolve: async () => [publicAddress],
        request: ((_options: unknown, _callback: unknown) => {
          const outgoing = new EventEmitter() as EventEmitter & {
            end: () => void;
            destroy: (error?: Error) => void;
          };
          outgoing.end = () => queueMicrotask(() => outgoing.emit("timeout"));
          outgoing.destroy = (error) => queueMicrotask(() => outgoing.emit("error", error));
          return outgoing as unknown as ClientRequest;
        }) as never,
      }),
    ).rejects.toThrow("File server did not respond");

    await expect(
      downloadPublicFile("https://files.example/report.pdf", {
        resolve: async () => [publicAddress],
        requestPublicFile: async () => ({
          statusCode: 302,
          headers: { location: "https://%" },
          bytes: new Uint8Array(),
        }),
      }),
    ).rejects.toThrow("Invalid file redirect");
  });

  test("enforces declared and streamed byte limits", async () => {
    await expect(
      downloadPublicFile("https://files.example/declared", {
        resolve: async () => [publicAddress],
        request: fakeRequest({ headers: { "content-length": "6" }, chunks: ["123456"] }),
        maxBytes: 5,
      }),
    ).rejects.toThrow("5 byte limit");

    await expect(
      downloadPublicFile("https://files.example/chunked", {
        resolve: async () => [publicAddress],
        request: fakeRequest({ chunks: ["123", "456"] }),
        maxBytes: 5,
      }),
    ).rejects.toThrow("5 byte limit");
  });

  test("does not retry another address after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;

    await expect(
      downloadPublicFile("https://files.example/report.pdf", {
        resolve: async () => [publicAddress, { address: "203.0.114.11", family: 4 }],
        request: ((_options: unknown, _callback: unknown) => {
          requests += 1;
          const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
          outgoing.end = () => undefined;
          outgoing.destroy = (error) => queueMicrotask(() => outgoing.emit("error", error));
          return outgoing as unknown as ClientRequest;
        }) as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(requests).toBe(1);
  });

  test("stores a sanitized, assistant-owned conversation file and returns its canonical stat", async () => {
    const originalCreate = aiFileStore.createAssistantFile;
    const calls: Parameters<typeof aiFileStore.createAssistantFile>[0][] = [];
    aiFileStore.createAssistantFile = async (input) => {
      calls.push(input);
      return {
        path: "/imports/report_-2.pdf",
        size: input.bytes.byteLength,
        mediaType: input.mediaType ?? "application/octet-stream",
        origin: "assistant",
        updatedAt: "2026-08-21T12:00:00.000Z",
        version: 1,
      };
    };
    try {
      const result = await runCloudAiFetchFile(
        { url: "https://files.example/source", filename: "report<>.pdf" },
        { conversationId: "conversation-1" },
        {
          resolve: async () => [publicAddress],
          requestPublicFile: async () => ({
            statusCode: 200,
            headers: { "content-type": "application/pdf; charset=binary" },
            bytes: new TextEncoder().encode("PDF"),
          }),
        },
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        conversationId: "conversation-1",
        path: "/imports/report__.pdf",
        mediaType: "application/pdf",
      });
      expect(result).toEqual({
        path: "/imports/report_-2.pdf",
        size: 3,
        mediaType: "application/pdf",
        url: "https://files.example/source",
      });
      expect(CloudAiFetchFileInputSchema.parse({ url: result.url, filename: "report.pdf" })).toEqual({
        url: result.url,
        filename: "report.pdf",
      });
    } finally {
      aiFileStore.createAssistantFile = originalCreate;
    }
  });

  test("requires a conversation context before downloading", async () => {
    let requested = false;
    await expect(
      runCloudAiFetchFile(
        { url: "https://files.example/report.pdf" },
        {},
        {
          requestPublicFile: async () => {
            requested = true;
            return { statusCode: 200, headers: {}, bytes: new Uint8Array() };
          },
        },
      ),
    ).rejects.toThrow("conversation context");
    expect(requested).toBe(false);
  });
});

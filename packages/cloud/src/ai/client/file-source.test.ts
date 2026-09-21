import { expect, test } from "bun:test";
import { conversationFileSource } from "./file-source";

test("conversation file uploads preserve the selected directory", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; directory: FormDataEntryValue | null; name: string }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!(init?.body instanceof FormData)) throw new Error("Expected multipart upload");
      const file = init.body.get("file");
      if (!(file instanceof File)) throw new Error("Expected file");
      requests.push({ path: String(input), directory: init.body.get("directory"), name: file.name });
      return Response.json({ file: { path: "/files/results-2.csv" } });
    },
    { preconnect: original.preconnect },
  );
  try {
    await conversationFileSource("/api/ai", "test-chat").upload!("/files", [new File(["x"], "results.csv")]);
    expect(requests).toEqual([{ path: "/api/ai/conversations/test-chat/files", directory: "/files", name: "results.csv" }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("CSV previews preserve non-UTF8 bytes for decoding preferences", async () => {
  const original = globalThis.fetch;
  const bytes = Uint8Array.from([110, 97, 109, 101, 59, 118, 10, 83, 252, 100, 59, 49]);
  globalThis.fetch = Object.assign(async () => new Response(bytes, { headers: { "content-type": "text/csv" } }), {
    preconnect: original.preconnect,
  });
  try {
    const preview = await conversationFileSource("/api/ai", "test-chat").read("/sales.csv");
    expect(preview.encoding).toBe("base64");
    expect(Uint8Array.from(atob(preview.content), (character) => character.charCodeAt(0))).toEqual(bytes);
  } finally {
    globalThis.fetch = original;
  }
});

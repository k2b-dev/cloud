import { expect, test } from "bun:test";
import { hc } from "hono/client";
import type { ApiType } from ".";

test("the typed Chat client sends multipart files, attachment IDs and download parameters", async () => {
  const calls: Request[] = [];
  const client = hc<ApiType>("https://cloud.example.test/api/chat", {
    fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(new Request(input, init));
      return Response.json({});
    },
  });
  const conversation = client.conversations[":conversation"];
  await conversation.attachments.$post({
    param: { conversation: "abcdef" },
    form: { file: new File(["text"], "notes.txt", { type: "text/plain" }), thread: "thread" },
  });
  const form = await calls[0]!.formData();
  expect(form.get("file")).toBeInstanceOf(File);
  expect(form.get("thread")).toBe("thread");
  await conversation.messages.$post({ param: { conversation: "abcdef" }, json: { clientId: "once", body: "", attachments: ["attach"] } });
  expect(await calls[1]!.json()).toMatchObject({ body: "", attachments: ["attach"] });
  await conversation.attachments[":attachment"].$get({ param: { conversation: "abcdef", attachment: "attach" } });
  expect(calls[2]!.url).toBe("https://cloud.example.test/api/chat/conversations/abcdef/attachments/attach");
});

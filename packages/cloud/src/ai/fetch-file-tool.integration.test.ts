import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import type { RequestActor } from "../server";
import { runCloudAiFetchFile } from "./fetch-file-tool";
import { createCloudAiPresentTool, createCloudAiReadFileTool } from "./file-tools";
import { aiFileStore } from "./files-store";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const suite = databaseSuite();

suite("fetch_file integration", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("stores raw HTML and readable Markdown in imports and reads it through read_file", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`fetch-html-${suffix}`}, 'local', 'user', 'Fetch HTML Test', ${`fetch-html-${suffix}@example.test`}, 'Fetch', 'HTML')
      RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    try {
      const fetched = await runCloudAiFetchFile(
        { url: "https://files.example/article.html" },
        { conversationId: conversation.id },
        {
          resolve: async () => [{ address: "203.0.114.10", family: 4 }],
          requestPublicFile: async () => ({
            statusCode: 200,
            headers: { "content-type": "text/html" },
            bytes: new TextEncoder().encode(
              "<title>Article</title><article><p>Readable article text.</p><script>SECRET_SCRIPT</script></article>",
            ),
          }),
        },
      );
      expect(fetched.readable).toBeDefined();
      const files = await aiFileStore.list({ conversationId: conversation.id, prefix: "/imports" });
      expect(files).toHaveLength(2);
      expect(files.map((file) => file.path).sort()).toEqual(["/imports/article.html", "/imports/article.md"]);
      const raw = await aiFileStore.read({ conversationId: conversation.id, path: fetched.path });
      expect(new TextDecoder().decode(raw!.bytes)).toContain("SECRET_SCRIPT");
      const read = createCloudAiReadFileTool();
      if (read.location !== "server") throw new Error("Expected a server file tool");
      const result = await read.run({ path: fetched.readable!.path, offset: 0, length: 16_384 }, {
        actor: { kind: "user", user: { id: user!.id, uid: `fetch-html-${suffix}`, roles: ["user"], provider: "local" } },
        conversationId: conversation.id,
        turnId: crypto.randomUUID(),
        attachedFilePaths: new Set<string>(),
      } as never);
      expect(result).toMatchObject({ path: fetched.readable!.path, content: "# Article\n\nReadable article text.\n", eof: true });
      expect(JSON.stringify(result)).not.toContain("SECRET_SCRIPT");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
  test("imports, reads, and presents one file in the same turn", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`fetch-file-${suffix}`}, 'local', 'user', 'Fetch File Test', ${`fetch-file-${suffix}@example.test`}, 'Fetch', 'File')
      RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    const actor = {
      kind: "user",
      user: { id: user!.id, uid: `fetch-file-${suffix}`, roles: ["user"], provider: "local" },
    } as RequestActor;

    try {
      const fetched = await runCloudAiFetchFile(
        { url: "https://files.example/notes.txt" },
        { conversationId: conversation.id },
        {
          resolve: async () => [{ address: "203.0.114.10", family: 4 }],
          requestPublicFile: async () => ({
            statusCode: 200,
            headers: { "content-type": "text/plain" },
            bytes: new TextEncoder().encode("Imported source"),
          }),
        },
      );
      const context = {
        actor,
        conversationId: conversation.id,
        turnId: crypto.randomUUID(),
        attachedFilePaths: new Set<string>(),
      };
      const read = createCloudAiReadFileTool();
      const present = createCloudAiPresentTool();
      if (read.location !== "server" || present.location !== "server") throw new Error("Expected server file tools");

      expect(await read.run({ path: fetched.path, offset: 0, length: 16_384 }, context as never)).toMatchObject({
        path: fetched.path,
        content: "Imported source",
        eof: true,
      });
      expect(await present.run({ path: fetched.path }, context as never)).toEqual({
        path: fetched.path,
        size: 15,
        mediaType: "text/plain",
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});

import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { RequestActor } from "../server";
import { createCloudAiPresentTool, createCloudAiReadFileTool } from "./file-tools";
import { runCloudAiFetchFile } from "./fetch-file-tool";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const canUseAiDatabase = async () => {
  try {
    const [authRow] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!authRow?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

const suite = (await canUseAiDatabase()) ? describe : describe.skip;

suite("fetch_file integration", () => {
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

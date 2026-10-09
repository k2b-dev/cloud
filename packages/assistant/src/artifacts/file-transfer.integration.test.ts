import { beforeAll, expect, test } from "bun:test";
import { aiConversations, aiProjects, migrateCloudAi } from "@k2b/cloud/ai";
import { sql } from "bun";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { studioFiles } from "./file-transfer";
import { testIdentity } from "./test-identity";

databaseSuite()("Studio image file transfers", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("legacy images copied into Projects and chats return the persisted version and size", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name, mail)
      VALUES (${`photo-transfer-${suffix}`}, 'local', 'user', 'Photo transfer', ${`photo-${suffix}@example.test`}) RETURNING id
    `;
    const identity = testIdentity(user!.id);
    const source = await aiConversations.createConversation({ ownerUserId: user!.id });
    const target = await aiConversations.createConversation({ ownerUserId: user!.id });
    const project = await aiProjects.create({ subject: identity.accessSubject, name: "Photo destination" });
    try {
      const jpeg = await tinyJpeg();
      const legacy = withCameraMetadata(jpeg, 1);
      await sql`
        INSERT INTO ai.files(conversation_id, path, bytes, size, media_type, origin)
        VALUES (${source.id}::uuid, '/legacy.jpg', ${legacy}, ${legacy.length}, 'application/octet-stream', 'user')
      `;
      const file = await studioFiles.read({ scope: "chat", id: source.id, path: "/legacy.jpg" }, identity);
      if (!file) throw new Error("Missing legacy source");
      for (const destination of [
        { scope: "project" as const, id: project.id, path: "copied.jpg" },
        { scope: "chat" as const, id: target.id, path: "/copied.jpg" },
      ]) {
        const copied = await studioFiles.copy(file.reference, destination, null, identity, new AbortController().signal);
        const stored = await studioFiles.readReference(copied.reference, identity);
        expect(stored.bytes).toEqual(jpeg);
        expect(copied.size).toBe(stored.bytes.length);
        expect(copied.mediaType).toBe("application/octet-stream");
        // The returned reference also authorizes an expected-version replacement.
        const replaced = await studioFiles.copy(
          file.reference,
          destination,
          copied.reference.version,
          identity,
          new AbortController().signal,
        );
        expect((await studioFiles.readReference(replaced.reference, identity)).bytes).toEqual(jpeg);
      }
    } finally {
      await sql`DELETE FROM ai.projects WHERE id=${project.id}::uuid`;
      await sql`DELETE FROM ai.conversations WHERE id IN (${source.id}::uuid, ${target.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});

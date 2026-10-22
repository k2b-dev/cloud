import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { useRemoteChangesFixture } from "./remote-changes-fixture";

describe("remote changes teardown", () => {
  const { connect, id } = useRemoteChangesFixture();
  let hungMailboxId = "";
  let hungSync: Promise<number> | null = null;

  // The first test's sync starts here, outside its one-second budget, and already waits on its held
  // envelope fetch when the test starts, so the timeout always hits a sync in flight.
  beforeEach(async () => {
    if (hungSync) return;
    const mailbox = await connect("hung-sync", false);
    hungMailboxId = mailbox.mailboxId;
    for (let index = 1; index <= 3; index += 1) mailbox.remote.put("archive", id(`hung-${index}`));
    const held = mailbox.remote.holdNextEnvelopes();
    hungSync = mailbox.sync("archive");
    await held;
  });

  test("a sync that outlives its test", async () => {
    await hungSync;
  }, 1_000);

  test("the next test sees none of it", async () => {
    const mailbox = await connect("next-sync", false);
    mailbox.remote.put("archive", id("next-first"));
    mailbox.remote.put("archive", id("next-second"));
    await mailbox.sync("archive");

    expect(mailbox.remote.calls).toEqual({ envelopes: 1, windows: [["archive", 1, 2]], draftCounts: 0 });
    expect(
      await sql<{ message_id: string; role: string; deleted: boolean }[]>`
        SELECT content.message_id, folder.role, placement.deleted_at IS NOT NULL AS deleted
        FROM mail.message_placements placement
        JOIN mail.folders folder ON folder.id = placement.folder_id
        JOIN mail.message_contents content ON content.id = placement.message_id
        WHERE content.mailbox_id = ${mailbox.mailboxId}::uuid
        ORDER BY content.message_id
      `,
    ).toEqual([
      { message_id: id("next-first"), role: "archive", deleted: false },
      { message_id: id("next-second"), role: "archive", deleted: false },
    ]);
    expect(hungMailboxId).not.toBe("");
    expect(await sql`SELECT id FROM mail.message_contents WHERE mailbox_id = ${hungMailboxId}::uuid`).toHaveLength(0);
    expect(
      await sql`
        SELECT run.id FROM mail.sync_runs run
        JOIN mail.remote_resources resource ON resource.id = run.remote_resource_id
        WHERE resource.mailbox_id = ${hungMailboxId}::uuid AND run.state = 'running'
      `,
    ).toHaveLength(0);
  });
});

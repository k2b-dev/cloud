import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrate as chat } from "../packages/chat/src/migrate";
import { listConversationManagers } from "../packages/chat/src/service/manager-recipients";
import { sql } from "../packages/cloud/src/runtime/clients";
import { migrate as contacts } from "../packages/contacts/src/migrate";
import { listBookManagers } from "../packages/contacts/src/service/manager-recipients";
import { migrate as auth } from "../packages/core/src/migrate/core/auth";
import { migrate as events } from "../packages/core/src/migrate/core/events";
import { migrate as extensions } from "../packages/core/src/migrate/core/extensions";
import { migrate as settings } from "../packages/core/src/migrate/core/settings";
import { migrate as workflows } from "../packages/core/src/migrate/core/workflows";
import { migrate as files } from "../packages/filesv2/src/migrate";
import { listFilesManagers } from "../packages/filesv2/src/service/manager-recipients";
import { migrate as grids } from "../packages/grids/src/migrate";
import { listBaseManagers as gridManagers } from "../packages/grids/src/service/manager-recipients";
import { migrate as notebooks } from "../packages/notebooks/src/migrate";
import { listNotebookManagers } from "../packages/notebooks/src/service/manager-recipients";
import { migrate as pulse } from "../packages/pulse/src/migrate";
import { listBaseManagers as pulseManagers } from "../packages/pulse/src/service/manager-recipients";
import { migrate as spaces } from "../packages/spaces/src/migrate";
import { listSpaceManagers } from "../packages/spaces/src/service/manager-recipients";
import { migrate as venue } from "../packages/venue/src/migrate";
import { listVenueManagers } from "../packages/venue/src/service/manager-recipients";
import { databaseSuite, useFreshDatabase } from "../scripts/fixtures/test-infra";

const person = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
databaseSuite()("Code owner manager projections", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  afterAll(async () => {
    await database?.drop();
  });
  beforeAll(async () => {
    database = await useFreshDatabase("code_owner_managers");
    await extensions();
    await auth();
    await events();
    await settings();
    await workflows();
  });
  for (const migrate of [spaces, contacts, notebooks, grids, chat, venue, files]) beforeAll(migrate);
  beforeAll(() => pulse("UTC"));
  beforeAll(async () => {
    for (const id of [person, other]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
  });
  const owners = [
    { app: "spaces", table: "spaces", junction: "space_access", key: "space_id", list: listSpaceManagers },
    { app: "contacts", table: "books", junction: "book_access", key: "book_id", list: listBookManagers },
    { app: "notebooks", table: "notebooks", junction: "notebook_access", key: "notebook_id", list: listNotebookManagers },
    {
      app: "grids",
      table: "bases",
      junction: "base_access",
      key: "base_id",
      list: (input: Parameters<typeof gridManagers>[0]) => gridManagers(input, AbortSignal.timeout(5000)),
    },
    { app: "pulse", table: "bases", junction: "base_access", key: "base_id", list: pulseManagers },
    { app: "chat", table: "conversations", junction: "conversation_access", key: "conversation_id", list: listConversationManagers },
    { app: "venue", table: "venues", junction: "venue_access", key: "venue_id", list: listVenueManagers },
  ];
  for (const resource of owners)
    test(`${resource.app}: nested group managers, current revocation, bounded pages and all-signed-in grants`, async () => {
      const [parent] =
        await sql`INSERT INTO auth.groups(cn,name,provider) VALUES(${`${resource.app}-parent`},${`${resource.app}-parent`},'local') RETURNING id`;
      const [child] =
        await sql`INSERT INTO auth.groups(cn,name,provider) VALUES(${`${resource.app}-child`},${`${resource.app}-child`},'local') RETURNING id`;
      await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${parent!.id}::uuid,${child!.id}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${person}::uuid,${child!.id}::uuid)`;
      const id = crypto.randomUUID();
      if (resource.app === "chat")
        await sql`INSERT INTO chat.conversations(id,short_id,name,created_by_type,created_by_id) VALUES(${id}::uuid,'Mgr001','Fixture','user',${person}::uuid)`;
      else if (resource.app === "venue")
        await sql`INSERT INTO venue.venues(id,short_id,name,slug) VALUES(${id}::uuid,'Mgr001','Fixture','manager-fixture')`;
      else
        await sql`INSERT INTO ${sql.unsafe(`${resource.app}.${resource.table}`)}(id,short_id,name) VALUES(${id}::uuid,'Mgr001','Fixture')`;
      const [grant] = await sql`INSERT INTO auth.access(group_id,permission) VALUES(${parent!.id}::uuid,'admin') RETURNING id`;
      const join = async (accessId: string) => {
        if (resource.app === "chat")
          await sql`INSERT INTO chat.conversation_access(conversation_id,access_id,role,added_by_type,added_by_id) VALUES(${id}::uuid,${accessId}::uuid,'member','user',${person}::uuid)`;
        else
          await sql`INSERT INTO ${sql.unsafe(`${resource.app}.${resource.junction}`)}(${sql.unsafe(resource.key)},access_id) VALUES(${id}::uuid,${accessId}::uuid)`;
      };
      await join(grant!.id);
      expect(await resource.list({ id: "Mgr001", limit: 50 })).toEqual([person]);
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id=${person}::uuid AND group_id=${child!.id}::uuid`;
      expect(await resource.list({ id: "Mgr001", limit: 50 })).toEqual([]);
      const [all] = await sql`INSERT INTO auth.access(authenticated_only,permission) VALUES(true,'admin') RETURNING id`;
      await join(all!.id);
      expect(await resource.list({ id: "Mgr001", limit: 1 })).toEqual([person]);
      expect(await resource.list({ id: "Mgr001", limit: 1, afterId: person })).toEqual([other]);
      expect(await resource.list({ id: "Mgr001", limit: 50, userId: other })).toEqual([other]);
      if (resource.app === "grids") {
        const [deny] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${person}::uuid,'read') RETURNING id`;
        await join(deny!.id);
        expect(await resource.list({ id: "Mgr001", limit: 1 })).toEqual([other]);
      }
    });
  test("Chat discoverability and system conversations confer no management", async () => {
    const [conversation] = await sql`SELECT id FROM chat.conversations WHERE short_id='Mgr001'`;
    await sql`UPDATE chat.conversation_access SET role='discoverable' WHERE conversation_id=${conversation!.id}::uuid`;
    expect(await listConversationManagers({ id: "Mgr001", limit: 50 })).toEqual([]);
    await sql`UPDATE chat.conversation_access SET role='member' WHERE conversation_id=${conversation!.id}::uuid`;
    await sql`UPDATE chat.conversations SET kind='system' WHERE id=${conversation!.id}::uuid`;
    expect(await listConversationManagers({ id: "Mgr001", limit: 50 })).toEqual([]);
  });
  test("notes and items inherit their current parent's managers", async () => {
    const [notebook] = await sql`SELECT id FROM notebooks.notebooks WHERE short_id='Mgr001'`;
    await sql`INSERT INTO notebooks.notes(notebook_id,short_id,title) VALUES(${notebook!.id}::uuid,'Note01','Fixture')`;
    expect(await listNotebookManagers({ id: "Note01", limit: 50 }, true)).toEqual([person, other]);
    const [space] = await sql`SELECT id FROM spaces.spaces WHERE short_id='Mgr001'`;
    const [column] =
      await sql`INSERT INTO spaces.columns(space_id,name,short_id) VALUES(${space!.id}::uuid,'Fixture','Col001') RETURNING id`;
    await sql`INSERT INTO spaces.items(space_id,column_id,short_id,title) VALUES(${space!.id}::uuid,${column!.id}::uuid,'Item01','Fixture')`;
    expect(await listSpaceManagers({ id: "Item01", limit: 50 }, true)).toEqual([person, other]);
    await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM spaces.space_access WHERE space_id=${space!.id}::uuid)`;
    expect(await listSpaceManagers({ id: "Item01", limit: 50 }, true)).toEqual([]);
  });
  test("Files administration surfaces enumerate installation admins and recheck removal", async () => {
    await sql`UPDATE auth.users SET admin=true WHERE id=${person}::uuid`;
    const [template] =
      await sql`INSERT INTO filesv2.templates(name,filename,bytes,size,created_by) VALUES('Fixture','fixture.txt','',0,${person}::uuid) RETURNING id`;
    expect(await listFilesManagers({ id: template!.id, limit: 50 }, "template")).toEqual([person]);
    const storageId = crypto.randomUUID(),
      machineId = crypto.randomUUID();
    await sql`INSERT INTO filesv2.bases(id,area,kind,identity_id,identity_name,root,path)
      VALUES(${storageId}::uuid,'cloud','users',${machineId}::uuid,'fixture-machine','fixture','fixture')`;
    await sql`INSERT INTO filesv2.machine_storage(base_id,owner_id,owner_kind,owner_name,server_url)
      VALUES(${storageId}::uuid,${machineId}::uuid,'agent','fixture-machine','http://fixture.invalid')`;
    expect(await listFilesManagers({ id: storageId, limit: 50 }, "storage")).toEqual([person]);
    await sql`UPDATE auth.users SET admin=false WHERE id=${person}::uuid`;
    expect(await listFilesManagers({ id: template!.id, limit: 50 }, "template")).toEqual([]);
    expect(await listFilesManagers({ id: storageId, limit: 50 }, "storage")).toEqual([]);
  });
});

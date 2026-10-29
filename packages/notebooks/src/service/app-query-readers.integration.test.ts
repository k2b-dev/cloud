import { expect, test } from "bun:test";
import type { CapabilityAppExecutionContext, CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { RequestActor } from "@k2b/cloud/server";
import { coreSettings, serviceAccounts, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { resolveUserReaders } from "@k2b/cloud/services/identity";
import { useTestSettings } from "@k2b/cloud/services/settings/settings.test-fixture";
import { notebooksCapabilities } from "../capabilities";
import { getActorsNotebookPermissions } from "./access";

const context: CapabilityAppExecutionContext = {
  actor: { kind: "app", appId: "chat" },
  accessSubject: { type: "none" },
  user: null,
  locale: "en",
  requestId: "reader-test",
  origin: "app",
  signal: new AbortController().signal,
};

databaseSuite()("notebooks app-query reader decisions", () => {
  useTestSettings({ "user.category.guest.enabled": true, "user.category.login.enabled": true });
  test("returns only current people with interactive read grants; unknown and deleted elements are empty", async () => {
    const users = await sql<{ id: string; profile: string }[]>`INSERT INTO auth.users (uid, provider, profile)
      VALUES (${`reader-${crypto.randomUUID()}`}, 'local', 'user'), (${`guest-${crypto.randomUUID()}`}, 'local', 'guest'),
        (${`expired-${crypto.randomUUID()}`}, 'local', 'user'), (${`denied-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id, profile`;
    const [person, guest, expired, denied] = users;
    const [parent] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO notebooks.notebooks (short_id, name) VALUES (${testShortId()}, 'Reader fixture') RETURNING id, short_id`;
    const accessIds: string[] = [];
    try {
      await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${expired!.id}::uuid`;
      for (const user of [person!, guest!, expired!]) {
        const [access] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access (user_id, permission) VALUES (${user.id}::uuid, 'read') RETURNING id`;
        accessIds.push(access!.id);
        await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${parent!.id}::uuid, ${access!.id}::uuid)`;
      }
      const [element] = await sql<
        { id: string; short_id: string }[]
      >`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md) VALUES (${testShortId()}, ${parent!.id}::uuid, 'Private title', 'Private content') RETURNING id, short_id`;
      const read = (id: string, userIds = users.map((user) => user.id)) =>
        notebooksCapabilities.queries["note.readable"].run(
          { id, container: { type: "notebooks.notebook", id: parent!.short_id }, userIds },
          context,
        );
      expect(await read(element!.short_id)).toEqual({ ok: true, data: { data: { readable: [person!.id, guest!.id] } } });
      await coreSettings.set("user.category.guest.enabled", false);
      expect(await read(element!.short_id, [guest!.id])).toEqual({ ok: true, data: { data: { readable: [] } } });
      await coreSettings.set("user.category.guest.enabled", true);
      // Interactive calls cannot use this endpoint as an arbitrary-person permission oracle.
      const [reader] = await resolveUserReaders([person!.id]);
      if (!reader) throw new Error("Missing reader");
      const peopleContext = {
        ...context,
        actor: reader.actor,
        accessSubject: reader.subject,
        user: reader.actor.user,
      } satisfies CapabilityExecutionContext;
      expect(
        (
          await notebooksCapabilities.queries["note.readable"].run(
            { id: element!.short_id, container: { type: "notebooks.notebook", id: parent!.short_id }, userIds: [person!.id] },
            peopleContext,
          )
        ).ok,
      ).toBe(false);
      expect(await read(testShortId())).toEqual({ ok: true, data: { data: { readable: [] } } });
      await sql`UPDATE auth.access SET permission = 'none' WHERE user_id = ${person!.id}::uuid AND id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
      expect(await read(element!.short_id, [person!.id, denied!.id])).toEqual({ ok: true, data: { data: { readable: [] } } });
      await sql`DELETE FROM notebooks.notes WHERE id = ${element!.id}::uuid`;
      expect(await read(element!.short_id)).toEqual({ ok: true, data: { data: { readable: [] } } });
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${parent!.id}::uuid`;
      if (accessIds.length) await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(users.map((user) => user.id))}::uuid[])`;
    }
  });
  test("reader decisions retain the expected container after a move and original access revocation", async () => {
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
      VALUES (${`move-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
    const parents = await sql<{ id: string; short_id: string }[]>`INSERT INTO notebooks.notebooks (short_id, name)
      VALUES (${testShortId()}, 'Original'), (${testShortId()}, 'Destination') RETURNING id, short_id`;
    const [original, destination] = parents;
    const accessIds: string[] = [];
    try {
      for (const container of parents) {
        const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
          VALUES (${person!.id}::uuid, 'read') RETURNING id`;
        accessIds.push(access!.id);
        await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${container.id}::uuid, ${access!.id}::uuid)`;
      }
      const [element] = await sql<{ id: string; short_id: string }[]>`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
        VALUES (${testShortId()}, ${original!.id}::uuid, 'Move fixture', '') RETURNING id, short_id`;
      const read = (containerId: string) =>
        notebooksCapabilities.queries["note.readable"].run(
          {
            id: element!.short_id,
            container: { type: "notebooks.notebook", id: containerId },
            userIds: [person!.id],
          },
          context,
        );
      expect(await read(original!.short_id)).toMatchObject({ data: { data: { readable: [person!.id] } } });
      await sql`UPDATE auth.access SET permission = 'none' WHERE id = ${accessIds[0]}::uuid`;
      expect(await read(original!.short_id)).toMatchObject({ data: { data: { readable: [] } } });
      await sql`UPDATE notebooks.notes SET notebook_id = ${destination!.id}::uuid WHERE id = ${element!.id}::uuid`;
      expect(await read(original!.short_id)).toEqual({ ok: true, data: { data: { readable: [] } } });
      expect(await read(destination!.short_id)).toMatchObject({ data: { data: { readable: [person!.id] } } });
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(${toPgUuidArray(parents.map((row) => row.id))}::uuid[])`;
      if (accessIds.length) await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id = ${person!.id}::uuid`;
    }
  });
  test("bulk helpers retain resource binding and scope ceilings", async () => {
    const [parent] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO notebooks.notebooks (short_id, name) VALUES (${testShortId()}, 'Bound fixture') RETURNING id, short_id`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES (${`bound-${crypto.randomUUID()}`}, 'resource_bound', 'notebooks', 'notebook', ${parent!.id}) RETURNING id`;
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'admin') RETURNING id`;
    try {
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${parent!.id}::uuid, ${access!.id}::uuid)`;
      const sa = await serviceAccounts.get({ id: account!.id });
      if (!sa) throw new Error("Missing fixture account");
      const actor: RequestActor = { kind: "service_account", serviceAccount: sa, delegatedUser: null, scopes: ["read"] };
      const reader = { actor, subject: { type: "service_account" as const, serviceAccountId: sa.id } };
      expect(await getActorsNotebookPermissions(parent!.id, [reader])).toEqual(["read"]);
      expect(await getActorsNotebookPermissions(parent!.id, [{ ...reader, actor: { ...actor, scopes: [] } }])).toEqual(["none"]);
      expect(
        await getActorsNotebookPermissions(parent!.id, [
          { ...reader, actor: { ...actor, serviceAccount: { ...sa, resourceId: crypto.randomUUID() } } },
        ]),
      ).toEqual(["none"]);
      const [element] = await sql<{ short_id: string }[]>`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
        VALUES (${testShortId()}, ${parent!.id}::uuid, 'Bound note', '') RETURNING short_id`;
      const result = await notebooksCapabilities.queries["note.readable"].run(
        { id: element!.short_id, container: { type: "notebooks.notebook", id: parent!.short_id }, userIds: [sa.id] },
        context,
      );
      expect(result).toEqual({ ok: true, data: { data: { readable: [] } } });
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${parent!.id}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${access!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  });
});

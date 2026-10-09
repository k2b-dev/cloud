import { expect, setDefaultTimeout, test } from "bun:test";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import type { ItemTemplateDraft, SpaceDetail, SpaceItem, SpaceItemTemplate, SpaceTaskChecklistEntry } from "../contracts";
import { newShortId } from "../lib/short-id";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(60_000);

type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

const caller =
  (token: string): Call =>
  async (path, init) =>
    spacesApi.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

const grant = async (
  spaceId: string,
  principal: { userId?: string; serviceAccountId?: string },
  permission: "read" | "write" | "admin",
) => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, service_account_id, permission)
    VALUES (${principal.userId ?? null}::uuid, ${principal.serviceAccountId ?? null}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

suite("Spaces item templates", () => {
  test("admins manage templates, writers create from them, readers only read", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [space] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Templates ${suffix}`}) RETURNING id, short_id`;
    try {
      const [column] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${space!.id}::uuid, 'Open', 1024)
        RETURNING id, short_id`;
      const [tag] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.tags (short_id, space_id, name, color) VALUES (${newShortId()}, ${space!.id}::uuid, 'Report', '#8b5cf6')
        RETURNING id, short_id`;

      const user = async (name: string, permission: "read" | "write" | "admin") => {
        const id = crypto.randomUUID();
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${id}::uuid, ${`${name}-${suffix}`}, 'local', 'user', ${name})`;
        const accessId = await grant(space!.id, { userId: id }, permission);
        const loaded = await accounts.users.get({ id });
        if (!loaded) throw new Error("Missing fixture user");
        const token = await serviceAccountCredentials.createUserApiToken({ user: loaded, name: `${name} key` });
        if (!token.ok) throw new Error(token.error.message);
        return { id, accessId, call: caller(token.data.token) };
      };
      const admin = await user("Admin", "admin");
      const writer = await user("Writer", "write");
      const reader = await user("Reader", "read");
      const leaver = await user("Leaver", "write");

      const [agentRow] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind) VALUES (${`Agent ${suffix}`}, 'agent') RETURNING id`;
      await grant(space!.id, { serviceAccountId: agentRow!.id }, "write");
      const agentToken = await serviceAccountCredentials.createApiToken({
        serviceAccountId: agentRow!.id,
        name: "write",
        scopes: ["read", "write"],
      });
      if (!agentToken.ok) throw new Error(agentToken.error.message);
      const agent = caller(agentToken.data.token);

      const base = `/${space!.short_id}`;
      const weekly = {
        kind: "task",
        name: "Weekly report",
        title: "Weekly report {{week}}",
        description: "What happened in week {{week}}?",
        priority: "medium",
        tagIds: [tag!.short_id],
        assigneeIds: [leaver.id],
        assignCreator: true,
        checklist: ["Collect numbers", "Write summary", "Send"],
        timeOfDay: "16:00",
        dateRule: { type: "weekdays", weekdays: ["WE", "TH"] },
      };

      // Only admins create; writers, readers, and a write-scoped agent cannot.
      expect((await writer.call(`${base}/templates`, { method: "POST", body: weekly })).status).toBe(403);
      expect((await reader.call(`${base}/templates`, { method: "POST", body: weekly })).status).toBe(403);
      expect((await agent(`${base}/templates`, { method: "POST", body: weekly })).status).toBe(403);
      const created = await admin.call(`${base}/templates`, { method: "POST", body: weekly });
      expect(created.status).toBe(200);
      const template = (await created.json()) as SpaceItemTemplate;
      expect(template).toMatchObject({
        kind: "task",
        name: "Weekly report",
        tags: [{ id: tag!.short_id, name: "Report" }],
        assignees: [{ id: leaver.id }],
        checklist: weekly.checklist,
        timeOfDay: "16:00",
        dateRule: { type: "weekdays", weekdays: ["WE", "TH"] },
      });
      expect(template.id).toMatch(/^[0-9A-Za-z]{6}$/);

      // Names are unique per Space and kind regardless of case; the other kind may reuse them.
      expect((await admin.call(`${base}/templates`, { method: "POST", body: { ...weekly, name: "WEEKLY REPORT" } })).status).toBe(409);
      const event = await admin.call(`${base}/templates`, {
        method: "POST",
        body: {
          kind: "event",
          name: "Weekly report",
          title: "Review",
          location: "Room 2",
          durationMinutes: 45,
          dateRule: { type: "offset", days: 2 },
        },
      });
      expect(event.status).toBe(200);
      // Fields of the other kind are refused.
      expect(
        (await admin.call(`${base}/templates`, { method: "POST", body: { kind: "event", name: "Bad", checklist: ["x"] } })).status,
      ).toBe(400);
      expect((await admin.call(`${base}/templates`, { method: "POST", body: { kind: "task", name: "Bad", location: "x" } })).status).toBe(
        400,
      );
      // An empty location means none, also for a task.
      const placeless = await admin.call(`${base}/templates`, { method: "POST", body: { kind: "task", name: "Placeless", location: "" } });
      expect(placeless.status).toBe(200);
      const placelessTemplate = (await placeless.json()) as SpaceItemTemplate;
      expect(placelessTemplate.location).toBeNull();
      expect((await admin.call(`${base}/templates/${placelessTemplate.id}`, { method: "PATCH", body: { location: "" } })).status).toBe(200);
      expect((await admin.call(`${base}/templates/${placelessTemplate.id}`, { method: "DELETE" })).status).toBe(200);

      // Everyone with read access lists them, in the Space detail too; readers cannot draft.
      const listed = (await (await reader.call(`${base}/templates?kind=task`)).json()) as SpaceItemTemplate[];
      expect(listed.map((entry) => entry.name)).toEqual(["Weekly report"]);
      const detail = (await (await reader.call(base)).json()) as SpaceDetail;
      expect(detail.templates.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["task:Weekly report", "event:Weekly report"]);
      expect((await reader.call(`${base}/templates/${template.id}/draft`)).status).toBe(403);

      // A draft proposes dates in the given zone and fills the create request.
      const draftResponse = await writer.call(`${base}/templates/${template.id}/draft?timeZone=Europe/Berlin&date=2026-10-14`);
      expect(draftResponse.status).toBe(200);
      const draft = (await draftResponse.json()) as ItemTemplateDraft;
      expect(draft.proposals).toHaveLength(3);
      expect(draft).toMatchObject({
        templateId: template.id,
        kind: "task",
        date: "2026-10-14",
        timeZone: "Europe/Berlin",
        item: {
          title: "Weekly report 42",
          deadline: "2026-10-14T14:00:00.000Z",
          tagIds: [tag!.short_id],
          assigneeIds: [leaver.id],
          assignCreator: true,
          checklist: weekly.checklist,
        },
      });
      expect((await writer.call(`${base}/templates/${template.id}/draft?timeZone=Mars/Base`)).status).toBe(400);
      expect((await writer.call(`${base}/templates/${template.id}/draft?date=2026-02-30`)).status).toBe(400);

      // A default assignee who lost access drops out of the template wherever it is read, so the web form, drafts,
      // and a settings save that sends the shown people back all keep working; the choice returns with the access.
      await sql`DELETE FROM auth.access WHERE id = ${leaver.accessId}::uuid`;
      const later = (await (await writer.call(`${base}/templates/${template.id}/draft?timeZone=UTC`)).json()) as ItemTemplateDraft;
      expect(later.item.assigneeIds).toEqual([]);
      const shown = (await (await admin.call(`${base}/templates/${template.id}`)).json()) as SpaceItemTemplate;
      expect(shown.assignees).toEqual([]);
      const inDetail = ((await (await reader.call(base)).json()) as SpaceDetail).templates.find((entry) => entry.id === template.id);
      expect(inDetail?.assignees).toEqual([]);
      const regranted = await grant(space!.id, { userId: leaver.id }, "write");
      expect(((await (await reader.call(`${base}/templates/${template.id}`)).json()) as SpaceItemTemplate).assignees).toMatchObject([
        { id: leaver.id },
      ]);
      await sql`DELETE FROM auth.access WHERE id = ${regranted}::uuid`;
      const resaved = await admin.call(`${base}/templates/${template.id}`, {
        method: "PATCH",
        body: { title: shown.title, assigneeIds: shown.assignees.map((assignee) => assignee.id) },
      });
      expect(resaved.status).toBe(200);

      // Creating from the draft makes the task, its checklist, and the creator's assignment in one request.
      const createdItem = await writer.call(`${base}/items`, {
        method: "POST",
        body: { ...later.item, columnId: column!.short_id },
      });
      expect(createdItem.status).toBe(200);
      const item = (await createdItem.json()) as SpaceItem;
      expect(item.assignees?.map((assignee) => assignee.id)).toEqual([writer.id]);
      expect(item.tags?.map((entry) => entry.id)).toEqual([tag!.short_id]);
      const checklist = (await (await writer.call(`${base}/items/${item.id}/checklist`)).json()) as SpaceTaskChecklistEntry[];
      expect(checklist.map((entry) => entry.label)).toEqual(weekly.checklist);
      // A service account has no person to assign.
      const agentItem = await agent(`${base}/items`, {
        method: "POST",
        body: { columnId: column!.short_id, title: "From agent", assignCreator: true },
      });
      expect(((await agentItem.json()) as SpaceItem).assignees).toEqual([]);
      // Events take no checklist.
      expect(
        (
          await writer.call(`${base}/items`, {
            method: "POST",
            body: {
              columnId: column!.short_id,
              title: "Event",
              startsAt: "2026-10-14T08:00:00.000Z",
              endsAt: "2026-10-14T09:00:00.000Z",
              checklist: ["x"],
            },
          })
        ).status,
      ).toBe(400);

      // Writers cannot change or delete; admins can, and removing a tag drops it from the template.
      expect((await writer.call(`${base}/templates/${template.id}`, { method: "PATCH", body: { name: "Mine" } })).status).toBe(403);
      expect((await writer.call(`${base}/templates/${template.id}`, { method: "DELETE" })).status).toBe(403);
      const renamed = await admin.call(`${base}/templates/${template.id}`, {
        method: "PATCH",
        body: { name: "Status report", dateRule: { type: "none" }, checklist: [] },
      });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()) as SpaceItemTemplate).toMatchObject({
        name: "Status report",
        dateRule: { type: "none" },
        checklist: [],
      });
      expect((await admin.call(`${base}/templates/${template.id}`, { method: "PATCH", body: { location: "Room 1" } })).status).toBe(400);
      await sql`DELETE FROM spaces.tags WHERE id = ${tag!.id}::uuid`;
      expect(((await (await admin.call(`${base}/templates/${template.id}`)).json()) as SpaceItemTemplate).tags).toEqual([]);
      expect((await admin.call(`${base}/templates/${template.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await admin.call(`${base}/templates/${template.id}`)).status).toBe(404);
      // The item made from it stays.
      expect((await writer.call(`${base}/items/${item.id}`)).status).toBe(200);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    }
  });
});

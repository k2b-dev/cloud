import { describe, expect, mock, test } from "bun:test";
import type { Paginated } from "@k2b/stdlib";
import type { EntityListItem, User } from "@valentinkolb/cloud/contracts/shared";
import { buildPrincipalLabelCache, type PrincipalValueValidationDeps, validatePrincipalValuesForActor } from "./principal-values";
import type { Field } from "./types";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const field = {
  id: uuid(1),
  tableId: uuid(2),
  shortId: "participants",
  name: "Participants",
  description: null,
  type: "principal",
  config: { cardinality: "multiple" },
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: true,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
} satisfies Field;

const actor = {
  id: uuid(3),
  uid: "guest",
  roles: ["guest", "local", "local/guest"],
  provider: "local",
  profile: "guest",
} as User;

const paginated = (items: EntityListItem[]): Paginated<EntityListItem> => ({
  items,
  page: 1,
  perPage: 100,
  total: items.length,
  hasNext: false,
});

const deps = (visible: EntityListItem[]): PrincipalValueValidationDeps => ({
  getUser: mock(async () => actor) as PrincipalValueValidationDeps["getUser"],
  listEntities: mock(async (config) => {
    const ids = new Set(config.kinds?.includes("user") ? config.userIds : config.groupIds);
    return paginated(
      visible.filter((item) => (item.kind === "user" ? ids.has(item.user.id) : item.kind === "group" ? ids.has(item.group.id) : false)),
    );
  }) as PrincipalValueValidationDeps["listEntities"],
});

describe("principal values", () => {
  test("accepts only users and groups visible to the writing actor", async () => {
    const userId = uuid(4);
    const groupId = uuid(5);
    const values = [
      { type: "user" as const, id: userId },
      { type: "group" as const, id: groupId },
    ];
    const visible = [
      {
        kind: "user",
        user: {
          id: userId,
          uid: "guest",
          roles: ["guest", "local", "local/guest"],
          provider: "local",
          profile: "guest",
          givenname: "Guest",
          sn: "Reader",
          displayName: "Guest Reader",
          mail: null,
          avatarHash: null,
        },
        relation: undefined,
      },
      {
        kind: "group",
        group: { id: groupId, provider: "local", name: "Team", description: null, gidnumber: null },
        relation: undefined,
      },
    ] as EntityListItem[];

    const visibleDeps = deps(visible);
    expect(await validatePrincipalValuesForActor({ [field.id]: values }, [field], actor.id, undefined, visibleDeps)).toEqual({
      ok: true,
      data: undefined,
    });
    expect(visibleDeps.listEntities).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ roles: actor.roles }) }),
    );
    expect(await buildPrincipalLabelCache(values, actor.id, deps(visible))).toEqual({ [userId]: "Guest Reader", [groupId]: "Team" });

    const hidden = await validatePrincipalValuesForActor({ [field.id]: values }, [field], actor.id, undefined, deps(visible.slice(0, 1)));
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) {
      expect(hidden.error.code).toBe("BAD_INPUT");
      expect(hidden.error.message).toContain("selected user or group is unavailable");
    }
  });

  test("requires a current user for non-empty principal values", async () => {
    const result = await validatePrincipalValuesForActor(
      { [field.id]: [{ type: "user", id: uuid(4) }] },
      [field],
      null,
      undefined,
      deps([]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  test("localizes validation errors for regional German locales", async () => {
    const result = await validatePrincipalValuesForActor({ [field.id]: [{ type: "user", id: uuid(4) }] }, [field], null, "de-CH", deps([]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Melde dich an, um Benutzer oder Gruppen auszuwählen.");
  });
});

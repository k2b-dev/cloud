import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { loadJwtSessionUser } from "./user";

describe("JWT session actor query", () => {
  test("uses exactly one database execution for the family and complete actor", async () => {
    let executions = 0;
    const query = (() => {
      executions += 1;
      return Promise.resolve([
        {
          id: "7bd9706e-6c70-4dd5-946f-0caac02bfc2a",
          uid: "one-trip-user",
          provider: "local",
          profile: "user",
          given_name: "One",
          sn: "Trip",
          display_name: "One Trip",
          mail: "one-trip@example.test",
          avatar_hash: null,
          account_expires: null,
          last_login_local: null,
          admin: false,
          effective_admin: false,
          member_groups: [],
          member_group_ids: [],
          manages: [],
          manages_group_ids: [],
        },
      ]);
    }) as unknown as typeof sql;

    const user = await loadJwtSessionUser(
      {
        userId: "7bd9706e-6c70-4dd5-946f-0caac02bfc2a",
        sid: "1e9e8ee1-8295-4820-b46f-7655fea86c9f",
        authEpoch: 2,
        groupsAdmin: ["admins"],
      },
      query,
    );

    expect(executions).toBe(1);
    expect(user?.id).toBe("7bd9706e-6c70-4dd5-946f-0caac02bfc2a");
    expect(user?.roles).toContain("user");
  });
});

import { expect, mock, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import { sql } from "../../runtime/clients";
import * as localUsers from "../providers/local/users";
import * as settings from "../settings";
import { buildBaseUser } from "./base-user";
import type { AccountsNotificationSender } from "./notification-sender";
import * as users from "./users";

useUnitClients();

const row = {
  id: "c5000000-0000-4000-8000-000000000001",
  uid: "admin",
  provider: "local" as const,
  profile: "user" as const,
  admin: true,
  emergency_admin: false,
  mail: "legacy-admin@example.test",
};

test("an unmarked local admin retains the reserved-name sign-in link and token restriction", async () => {
  const get = spyOn(users, "getMinimal").mockResolvedValue({
    ...buildBaseUser(row),
    accountExpires: null,
    storedAdmin: true,
    emergency_admin: false,
  });
  const send = mock(async () => ({ id: "unexpected", status: "queued" as const }));
  const sender: AccountsNotificationSender = {
    sendLoginLink: send,
    sendFreeIpaWelcome: send,
    sendLocalWelcome: send,
    sendRequestDenied: send,
    sendAdministrativeMessage: send,
  };
  try {
    const denied = { ok: false, status: 403, error: expect.stringContaining("admin login token") };
    expect(await users.sendLoginLink({ id: row.id, notificationSender: sender })).toMatchObject(denied);
    expect(await users.createLoginToken({ id: row.id })).toMatchObject(denied);
    expect(send).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
});

test("an unmarked local admin retains the reserved-name email exemption", async () => {
  const client = Object.assign(new SQL("postgres://127.0.0.1:1/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  let updated = false;
  const tx = new Proxy(client, {
    apply(_target, _receiver, [strings]) {
      const statement = strings.join("?").trim();
      if (statement.startsWith("SELECT uid, provider")) return Promise.resolve([row]);
      if (statement.startsWith("UPDATE auth.users")) {
        updated = true;
        return Promise.resolve([]);
      }
      if (statement.startsWith("LOCK TABLE auth.users")) return Promise.resolve([]);
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return await run(tx);
  });
  const setting = spyOn(settings, "get").mockResolvedValue(false);
  try {
    expect(await localUsers.update({ id: row.id, data: { mail: null } })).toEqual({ ok: true, data: undefined });
    expect(updated).toBe(true);
    expect(setting).not.toHaveBeenCalled();
  } finally {
    begin.mockRestore();
    setting.mockRestore();
    await client.close();
  }
});

import { expect, test } from "bun:test";
import { connections, getProcessSync, sql } from "@k2b/cloud";
import { suiteFor } from "../../../scripts/fixtures/test-infra";

suiteFor("database", "nats")("Mail platform startup", () => {
  test("initializes native connections only after selecting the cloned database and private namespace", async () => {
    const state = connections();
    const [row] = await sql`SELECT current_database() AS name`;
    expect(state.appId).toBe("mail");
    expect(row.name).toMatch(/^mail_[a-f0-9]+_test$/);
    expect(decodeURIComponent(new URL(state.database.url).pathname.slice(1))).toBe(row.name);
    expect(state.nats.namespace).toMatch(/^test-mail-/);
    expect(getProcessSync().health().state).toBe("ready");
  });
});

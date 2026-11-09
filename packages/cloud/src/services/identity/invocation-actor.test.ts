import { describe, expect, spyOn, test } from "bun:test";
import { SQL, type sql } from "bun";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import { resolveInvocationAuthority } from "./invocation-actor";
import type { CloudInvocationClaims } from "./invocation-token";
import { nestedInvocationLeases } from "./nested-invocation";

useUnitClients();

const claims = (principal: "user" | "service_account"): CloudInvocationClaims => ({
  iss: "https://cloud.example.test",
  aud: "app:mail",
  token_use: "invocation",
  sub: "11111111-1111-4111-8111-111111111111",
  principal_type: principal,
  access_subject_type: principal,
  access_subject_id: "11111111-1111-4111-8111-111111111111",
  act: { sub: "app:core" },
  credential_kind: principal === "user" ? "session" : "api_key",
  ...(principal === "service_account" ? { credential_id: "credential-1" } : {}),
  scopes: [],
  op: "capability.query:messages",
  schema_hash: null,
  ver: 1,
  jti: "22222222-2222-4222-8222-222222222222",
  iat: 1_700_000_000,
  nbf: 1_700_000_000,
  exp: 1_700_000_030,
});

describe("resolveInvocationAuthority", () => {
  for (const principal of ["user", "service_account"] as const) {
    test(`checks and loads a ${principal} in one PostgreSQL query`, async () => {
      let queries = 0;
      const query = (() => {
        queries += 1;
        return Promise.resolve([]);
      }) as unknown as typeof sql;

      expect(await resolveInvocationAuthority(claims(principal), query, ["admins"])).toBeNull();
      expect(queries).toBe(1);
    });
  }
});

describe("Code version entry admission", () => {
  const codeClaims = (principal: "user" | "service_account"): CloudInvocationClaims => ({
    ...claims(principal),
    credential_kind: "mandate",
    mandate_id: "33333333-3333-4333-8333-333333333333",
    mandate_revision: 1,
    workload_type: "code.version",
    workload_id: "approved-version",
    workload_run: "run-1",
    workload_trigger: {
      type: "mail.message.received",
      subject: { type: "mail.message", id: "Msg123" },
      place: { type: "mail.mailbox", id: "Box123" },
    },
  });
  for (const principal of ["user", "service_account"] as const) {
    test(`${principal}: missing, pending, paused, revoked or expired entry cannot admit the invocation`, async () => {
      // SQL owns the current-state predicate; an entry that does not satisfy it returns no row.
      let queries = 0;
      const query = (() => {
        queries++;
        return Promise.resolve([]);
      }) as unknown as typeof sql;
      expect(await resolveInvocationAuthority(codeClaims(principal), query, [])).toBeNull();
      expect(queries).toBe(1);
    });
    test(`${principal}: keys, scopes, missing version and missing run cannot replace the entry chain`, async () => {
      for (const changed of [
        { credential_kind: "api_key" as const },
        { scopes: ["write"] },
        { workload_id: undefined },
        { workload_run: undefined },
        { mandate_id: undefined },
        { mandate_revision: undefined },
      ]) {
        let queries = 0;
        const query = (() => {
          queries++;
          return Promise.resolve([]);
        }) as unknown as typeof sql;
        expect(await resolveInvocationAuthority({ ...codeClaims(principal), ...changed }, query, [])).toBeNull();
        expect(queries).toBe(0);
      }
    });
  }
});

const accountRow = {
  service_account_id: "11111111-1111-4111-8111-111111111111",
  service_account_name: "Code fixture",
  service_account_kind: "code",
  service_account_status: "active",
  delegated_user_id: null,
  app_id: null,
  resource_type: null,
  resource_id: null,
  service_account_created_by: null,
  service_account_created_at: "2026-11-01T00:00:00Z",
};

test("Code accounts reject API keys and ordinary invocation claims after loading the actual account", async () => {
  for (const credential_kind of ["api_key", "oauth", "session", "mandate"] as const) {
    let loaded = 0;
    const query = (() => {
      loaded++;
      return Promise.resolve([accountRow]);
    }) as unknown as typeof sql;
    expect(await resolveInvocationAuthority({ ...claims("service_account"), credential_kind }, query, [])).toBeNull();
    expect(loaded).toBe(1);
  }
});

test("the exact access subject is retained for users and Code accounts", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const userQuery = (() => {
    throw new Error("A different user subject must fail before loading");
  }) as unknown as typeof sql;
  expect(await resolveInvocationAuthority({ ...claims("user"), access_subject_id: other }, userQuery, [])).toBeNull();
  const base = {
    ...claims("service_account"),
    credential_kind: "mandate" as const,
    mandate_id: "33333333-3333-4333-8333-333333333333",
    mandate_revision: 1,
    workload_type: "code.version",
    workload_id: "approved-version",
    workload_run: "run-1",
    workload_trigger: {
      type: "mail.message.received",
      subject: { type: "mail.message", id: "Msg123" },
      place: { type: "mail.mailbox", id: "Box123" },
    },
  };
  for (const access_subject_id of [base.sub, other]) {
    let queries = 0;
    const query = (() => Promise.resolve(++queries === 1 ? [{ id: base.mandate_id }] : [accountRow])) as unknown as typeof sql;
    const result = await resolveInvocationAuthority({ ...base, access_subject_id }, query, []);
    if (access_subject_id === other) expect(result).toBeNull();
    else {
      expect(result?.accessSubject).toEqual({ type: "service_account", serviceAccountId: base.sub });
      expect(result?.scopes).toEqual([]);
      expect(result?.actor.delegation?.workloadTrigger).toEqual(base.workload_trigger);
      expect(result?.actor.kind === "service_account" && result.actor.scopes).toEqual(["read", "write"]);
    }
    expect(queries).toBe(2);
  }
});

test("an event visibility proof must still have a current claimed delivery before resolving the principal", async () => {
  const proof = {
    ...claims("service_account"),
    credential_kind: "mandate" as const,
    mandate_id: claims("user").sub,
    mandate_revision: 1,
    workload_type: "fixture",
    workload_id: "one",
    workload_event: claims("user").jti,
  };
  let count = 0;
  const query = (() => {
    count++;
    return Promise.resolve([]);
  }) as unknown as typeof sql;
  expect(await resolveInvocationAuthority(proof, query, [])).toBeNull();
  expect(count).toBe(1);
  count = 0;
  expect(await resolveInvocationAuthority({ ...proof, mandate_id: undefined }, query, [])).toBeNull();
  expect(count).toBe(0);
});

test("a nested visibility proof cannot replace its current parent lease", async () => {
  const client = new SQL("postgres://localhost/unused_test");
  const query = new Proxy(client, { apply: () => Promise.resolve([{ id: claims("user").jti }]) });
  const lease = spyOn(nestedInvocationLeases, "read").mockResolvedValue(null);
  try {
    expect(
      await resolveInvocationAuthority(
        {
          ...claims("service_account"),
          act: { sub: "app:fixture" },
          credential_kind: "mandate",
          mandate_id: claims("user").sub,
          mandate_revision: 1,
          workload_type: "fixture",
          workload_id: "one",
          workload_event: claims("user").jti,
          parent_invocation_id: claims("user").jti,
        },
        query,
        [],
      ),
    ).toBeNull();
    expect(lease).toHaveBeenCalledWith(claims("user").jti);
  } finally {
    lease.mockRestore();
    await client.close();
  }
});

test("a claimed Code event resolves its account without a run and retains event provenance", async () => {
  const eventClaims = {
    ...claims("service_account"),
    credential_kind: "mandate" as const,
    mandate_id: "33333333-3333-4333-8333-333333333333",
    mandate_revision: 1,
    workload_type: "code.version",
    workload_id: "approved-version",
    workload_event: claims("user").jti,
  };
  for (const currentEntry of [true, false]) {
    let queries = 0;
    const query = (() => {
      queries++;
      return Promise.resolve(
        queries === 1 ? [{ id: eventClaims.jti }] : queries === 2 ? (currentEntry ? [{ id: eventClaims.mandate_id }] : []) : [accountRow],
      );
    }) as unknown as typeof sql;
    const result = await resolveInvocationAuthority(eventClaims, query, []);
    if (!currentEntry) expect(result).toBeNull();
    else {
      expect(result?.accessSubject).toEqual({ type: "service_account", serviceAccountId: eventClaims.sub });
      expect(result?.actor.delegation).toMatchObject({ workloadEvent: eventClaims.workload_event, workloadType: "code.version" });
      expect(result?.scopes).toEqual([]);
    }
    expect(queries).toBe(currentEntry ? 3 : 2);
  }
});

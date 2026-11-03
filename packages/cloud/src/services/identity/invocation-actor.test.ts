import { describe, expect, test } from "bun:test";
import type { sql } from "bun";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import { resolveInvocationAuthority } from "./invocation-actor";
import type { CloudInvocationClaims } from "./invocation-token";

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

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as capabilities from "@k2b/cloud/capabilities/server";
import { AppAccessDeniedError } from "@k2b/cloud/server/middleware/app-access";
import * as identity from "@k2b/cloud/services/identity/issue-invocation";
import { adminAuthority } from "../../../../scripts/fixtures/app-status";
import { canReadCodeEventPlace, codeEventEntry, codeEventPrincipal } from "./event-access";

const account = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const resource = { owner: { kind: "resource" as const, ref: { type: "mail.mailbox", id: "Mbx001" } }, serviceAccountId: account };
const personal = { owner: { kind: "person" as const, userId: user }, serviceAccountId: null };
let reader: ReturnType<typeof spyOn<typeof capabilities, "readResourcePrincipals">> | undefined;
let appGate: ReturnType<typeof spyOn<typeof identity, "requireRegisteredAppAccess">>;
let authority: ReturnType<typeof spyOn<typeof identity, "resolveIssuanceAuthority">>;
beforeEach(() => {
  appGate = spyOn(identity, "requireRegisteredAppAccess").mockResolvedValue();
  authority = spyOn(identity, "resolveIssuanceAuthority").mockResolvedValue(adminAuthority());
});
afterEach(() => {
  reader?.mockRestore();
  appGate.mockRestore();
  authority.mockRestore();
});

test("foreign place checks use the executing account for two apps and repeat after revocation", async () => {
  let readable = true;
  reader = spyOn(capabilities, "readResourcePrincipals").mockImplementation(async (input) => ({
    state: "checked",
    readable: readable ? [...input.principals] : [],
  }));
  for (const place of [
    { type: "spaces.space", id: "Spc001" },
    { type: "notebooks.notebook", id: "Ntb001" },
  ]) {
    for (const code of [resource, personal]) {
      readable = true;
      expect(await canReadCodeEventPlace(code, place)).toBe(true);
      expect(reader).toHaveBeenLastCalledWith({ ref: place, principals: [codeEventPrincipal(code)], signal: undefined });
      readable = false;
      expect(await canReadCodeEventPlace(code, place)).toBe(false);
    }
  }
});
test("a guessed place without read access is refused; an unavailable check never grants access", async () => {
  reader = spyOn(capabilities, "readResourcePrincipals").mockResolvedValue({ state: "checked", readable: [] });
  expect(await canReadCodeEventPlace(resource, { type: "spaces.space", id: "guessed" })).toBe(false);
  reader.mockResolvedValue({ state: "not_configured", reason: "not_admitted" });
  await expect(canReadCodeEventPlace(resource, { type: "spaces.space", id: "Spc001" })).rejects.toThrow("cannot be checked");
});
test("the event and place pair, rather than the event type alone, selects a handler", () => {
  const place = { type: "spaces.space", id: "Spc001" };
  const entry = {
    kind: "event" as const,
    entrypoint: "event:spaces.item.due@1:place:0",
    cron: null,
    file: "code.ts",
    line: 1,
    event: { type: "spaces.item.due", version: 1, place },
  };
  const event = {
    id: account,
    time: "2026-11-01T00:00:00Z",
    type: "spaces.item.due",
    source: "spaces",
    version: 1,
    subject: { type: "spaces.item", id: "Itm001" },
    place,
    data: {},
  };
  const other = { ...entry, entrypoint: entry.entrypoint + "other", event: { ...entry.event, place: { ...place, id: "Spc002" } } };
  expect(codeEventEntry({ entrypoints: [other, entry] }, event)).toBe(entry);
  expect(codeEventEntry({ entrypoints: [entry] }, { ...event, place: { ...place, id: "undeclared" } })).toBeUndefined();
  expect(codeEventEntry({ entrypoints: [entry] }, { ...event, type: "spaces.item.created" })).toBeUndefined();
});

test("personal Code loses event access when its source app grant is withdrawn even if the object remains shared", async () => {
  reader = spyOn(capabilities, "readResourcePrincipals").mockImplementation(async (input) => ({
    state: "checked",
    readable: [...input.principals],
  }));
  const place = { type: "spaces.space", id: "Spc001" };
  expect(await canReadCodeEventPlace(personal, place)).toBe(true);
  appGate.mockRejectedValue(new AppAccessDeniedError({ id: "spaces" }));
  expect(await canReadCodeEventPlace(personal, place)).toBe(false);
  expect(reader).toHaveBeenCalledTimes(1);
  expect(authority).toHaveBeenLastCalledWith(
    { sub: user, principal_type: "user", access_subject_type: "user", access_subject_id: user, credential_kind: "session", scopes: [] },
    "core",
  );
});

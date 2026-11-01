import { afterEach, expect, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import * as access from "@k2b/cloud/capabilities/server";
import { CAPABILITY_MAX_RESULT_BYTES, type User } from "@k2b/cloud/contracts";
import type { CodeContext } from "./access";
import type { CodeActivationTarget } from "./activation-plan";
import { codeActivationTransport } from "./activation-transport";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "owner",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Owner",
  displayName: "Code Owner",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const principal = "22222222-2222-4222-8222-222222222222",
  grantId = "33333333-3333-4333-8333-333333333333";
const context: CodeContext = {
  authority: {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "session",
    scopes: [],
  },
};
const item: CodeActivationTarget = {
  target: { type: "example.item", id: "A" },
  operations: ["example.item.change"],
  grantId,
  reused: false,
  owner: false,
};
const input = {
  codeId: "c_test",
  versionId: "44444444-4444-4444-8444-444444444444",
  activationId: "55555555-5555-4555-8555-555555555555",
  activatingPerson: user.id,
  principal,
  item,
  dryRun: false,
};
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
function inspection() {
  const registry = spyOn(cloud, "getApp").mockResolvedValue({
    id: "example",
    name: "Example",
    icon: "ti ti-code",
    description: "Fixture",
    baseUrl: "http://example.internal",
    routes: ["/example"],
  });
  const list = spyOn(access, "signCodeAccessList").mockResolvedValue("list-token");
  const cleanup = spyOn(access, "signCodeAccessCleanup").mockResolvedValue("cleanup-token");
  restores.push(
    () => registry.mockRestore(),
    () => list.mockRestore(),
    () => cleanup.mockRestore(),
  );
  return { list, cleanup };
}
test("the real set transport binds proof identity and carries interactive authority only through Core dispatch", async () => {
  const sign = spyOn(access, "signCodeAccessProof").mockResolvedValue("proof"),
    invoke = spyOn(access, "invokeCodeAccess").mockResolvedValue(Response.json({ data: { granted: true, grantId, level: "write" } }));
  restores.push(
    () => sign.mockRestore(),
    () => invoke.mockRestore(),
  );
  expect(await codeActivationTransport.set(input, context)).toMatchObject({ granted: true, grantId });
  expect(sign.mock.calls[0]).toEqual([
    "example",
    {
      codeId: input.codeId,
      versionId: input.versionId,
      activationId: input.activationId,
      activatingPerson: user.id,
      principal,
      grantId,
      target: item.target,
      operations: item.operations,
    },
  ]);
  const call = invoke.mock.calls[0]![0];
  expect(call.authority).toBe(context.authority);
  expect(call.input).toEqual({ proof: "proof", target: item.target, operations: item.operations, dryRun: false });
  expect(call.request.headers.has("cookie")).toBe(false);
  expect(call.request.headers.has("authorization")).toBe(false);
});
test("cleanup false is verified by account-scoped list and refuses a still-live grant", async () => {
  const { list, cleanup } = inspection();
  const requests = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ data: { removed: false } }))
    .mockResolvedValueOnce(Response.json({ data: [{ grantId, principal, target: item.target, level: "write" }] }));
  restores.push(() => requests.mockRestore());
  await expect(codeActivationTransport.remove("example", principal, grantId)).rejects.toThrow("target_cleanup_refused");
  expect(cleanup).toHaveBeenCalledWith("example", principal);
  expect(list).toHaveBeenCalledWith("example", principal);
  const [url, init] = requests.mock.calls[0]!;
  expect(String(url)).toBe("http://example.internal/api/_internal/capabilities/v1/code-authority/actions/code.access.rm");
  expect(init?.headers).toEqual({ authorization: "Bearer cleanup-token", "content-type": "application/json" });
  expect(init?.body).toBe(JSON.stringify({ grantId }));
  expect(requests.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ principal }));
});
test("the HTTP transport bounds response bytes and retries ambiguous provider errors", async () => {
  inspection();
  const requests = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("x".repeat(CAPABILITY_MAX_RESULT_BYTES + 1)))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  restores.push(() => requests.mockRestore());
  await expect(codeActivationTransport.list("example", principal)).rejects.toMatchObject({
    code: "target_response_invalid",
    retryable: true,
  });
  await expect(codeActivationTransport.list("example", principal)).rejects.toMatchObject({ code: "target_http_503", retryable: true });
  await expect(codeActivationTransport.list("example", principal)).rejects.toMatchObject({ code: "target_http_403", retryable: false });
});

test("set transport strips unreadable presentation before forwarding and preserves readable presentation", async () => {
  const sign = spyOn(access, "signCodeAccessProof").mockResolvedValue("proof"),
    invoke = spyOn(access, "invokeCodeAccess");
  restores.push(
    () => sign.mockRestore(),
    () => invoke.mockRestore(),
  );
  for (const readable of [false, true])
    for (const granted of [false, true]) {
      invoke.mockResolvedValue(
        Response.json({
          data: {
            ...(granted
              ? { granted: true, grantId, level: "write" }
              : { granted: false, reasonCode: "not_manager", reason: "Fixture target requires its manager" }),
            readable,
            title: "Fixture target",
            managerUserIds: [user.id],
          },
        }),
      );
      const result = await codeActivationTransport.set({ ...input, dryRun: true }, { ...context, locale: "de" });
      if (readable) expect(result).toMatchObject({ title: "Fixture target", managerUserIds: [user.id] });
      else {
        expect(result).not.toHaveProperty("title");
        expect(result).not.toHaveProperty("managerUserIds");
        expect(JSON.stringify(result)).not.toContain("Fixture target");
        if (!result.granted) expect(result.reason).toBe("Einschalten kann nur, wer dieses Ziel verwaltet");
      }
    }
});
test("notification transport binds a separate Core-only proof and never uses interactive credentials", async () => {
  inspection();
  const sign = spyOn(access, "signCodeAccessNotifications").mockResolvedValue("notification-token"),
    requests = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { managerUserIds: [user.id] } }));
  restores.push(
    () => sign.mockRestore(),
    () => requests.mockRestore(),
  );
  const { dryRun: _, ...request } = input;
  expect(await codeActivationTransport.notificationManagers(request)).toEqual([user.id]);
  expect(sign).toHaveBeenCalledWith("example", {
    codeId: input.codeId,
    versionId: input.versionId,
    activationId: input.activationId,
    activatingPerson: user.id,
    principal,
    grantId,
    target: item.target,
    operations: item.operations,
  });
  expect(String(requests.mock.calls[0]![0])).toEndWith("/code-authority/queries/code.access.notifications");
  expect(requests.mock.calls[0]![1]?.headers).toEqual({ authorization: "Bearer notification-token" });
});

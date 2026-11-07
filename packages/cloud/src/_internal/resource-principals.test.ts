import { afterEach, expect, spyOn, test } from "bun:test";
import * as readers from "../services/identity/resource-readers";
import { activeResourcePrincipals } from "./resource-principals";

let resolve: ReturnType<typeof spyOn<typeof readers, "resolveResourceReaders">> | undefined;
afterEach(() => resolve?.mockRestore());

test("platform admission uses the shared reader resolver and preserves input principal spelling", async () => {
  const user = { type: "user", userId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" } as const;
  const missing = { type: "service_account", serviceAccountId: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" } as const;
  resolve = spyOn(readers, "resolveResourceReaders").mockResolvedValue([
    { principal: user, subject: { type: "user", userId: user.userId.toLowerCase() }, binding: null },
  ]);
  expect(await activeResourcePrincipals([user, missing])).toEqual([user]);
  expect(resolve).toHaveBeenCalledWith([user, missing]);
});

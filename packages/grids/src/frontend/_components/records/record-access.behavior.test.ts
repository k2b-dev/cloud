import { expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createRecordAccess } from "./record-access";

const settle = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
};

test.skipIf(isServer)("who has access loads once after the first record opens, and a failed refresh says so", async () => {
  const requests: string[] = [];
  let fail = false;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(String(input));
        if (fail) return Response.json({ message: "unavailable" }, { status: 503 });
        return Response.json([{ principal: { type: "user", userId: "33333333-3333-4333-8333-333333333333" }, permission: "write" }]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    await createRoot(async (dispose) => {
      const access = createRecordAccess(
        () => "BASE01",
        () => "failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Nothing loads before a record asks for it.
      expect(requests).toHaveLength(0);
      expect(access.state).toBe("loading");
      access.load();
      access.load();
      await settle(() => access.state === "ready");
      expect(requests).toEqual(["/api/grids/access/by-base/BASE01/members"]);
      expect(access.members).toHaveLength(1);
      // A failed refresh shows the failure instead of the list it can no longer vouch for.
      fail = true;
      access.retry();
      await settle(() => access.state === "error");
      dispose();
    });
  } finally {
    fetchMock.mockRestore();
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { inspectCloseSelection } from "./records-bulk-controller";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Close selection preview", () => {
  test("uses one bounded server preview and reports every Record blocker", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Response.json({
          items: [
            {
              ok: true,
              recordId: "recA",
              enabled: true,
              mode: "fourEyes",
              policyRevision: 4,
              finalized: false,
              pendingRequest: false,
              missingFieldNames: [],
            },
            {
              ok: true,
              recordId: "recB",
              enabled: true,
              mode: "fourEyes",
              policyRevision: 4,
              finalized: false,
              pendingRequest: false,
              missingFieldNames: ["Invoice date"],
            },
          ],
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    const preview = await inspectCloseSelection("Tbl001", ["recA", "recB"]);

    expect(preview.mode).toBe("fourEyes");
    expect(preview.policyRevision).toBe(4);
    expect(preview.blockers).toEqual([{ recordId: "recB", reason: "Complete: Invoice date." }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/grids/records/Tbl001/finalization/preview");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ recordIds: ["recA", "recB"] });
  });

  test("surfaces preview transport failures instead of inventing a policy blocker", async () => {
    globalThis.fetch = Object.assign(async () => new Response("offline", { status: 503 }), { preconnect: originalFetch.preconnect });
    await expect(inspectCloseSelection("Tbl001", ["recA"])).rejects.toThrow("Could not preview Finalization.");
  });

  test("keeps per-Record blockers when every selected Record is disabled", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          items: [
            {
              ok: true,
              recordId: "recA",
              enabled: false,
              mode: null,
              policyRevision: null,
              finalized: false,
              pendingRequest: false,
              missingFieldNames: [],
            },
          ],
        }),
      { preconnect: originalFetch.preconnect },
    );

    expect(await inspectCloseSelection("Tbl001", ["recA"])).toEqual({
      mode: null,
      policyRevision: null,
      blockers: [{ recordId: "recA", reason: "Finalization is not enabled for this Table." }],
    });
    expect(await inspectCloseSelection("Tbl001", ["recA"], undefined, "de-CH")).toEqual({
      mode: null,
      policyRevision: null,
      blockers: [{ recordId: "recA", reason: "Die Finalisierung ist für diese Tabelle nicht aktiviert." }],
    });
  });
});

import { afterAll, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { z } from "zod";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { sql } from "../runtime/clients";
import { createAppPwa } from "./index";
import * as schema from "./schema";

const options = {
  app: { id: "signing", installable: { path: "/app/signing/customer/" } },
  publicOrigin: "https://cloud.example.test",
  schema: "app_pwa_lazy_test",
  subject: z.strictObject({ documentId: z.uuid() }),
  budgets: { requestBytes: 8192, responseBytes: 8192, listPageSize: 10, maxAccessIds: 10 },
  authorizeStaff: async () => true,
  authorizeVisit: async () => true,
};

// Like an application module: no platform clients exist while the declaration is evaluated.
const pwa = createAppPwa(options);
const injectedDb = new SQL("postgres://127.0.0.1:1/unused_test");
const injected = createAppPwa({ ...options, db: injectedDb });
afterAll(() => injectedDb.close());
useUnitClients();

test.each(["first target", "replacement target"])("a pre-start App-PWA uses the current client: %s", async () => {
  const failure = new Error("current platform reservation");
  const reserve = spyOn(sql, "reserve").mockRejectedValue(failure);
  try {
    await expect(pwa.setup()).rejects.toBe(failure);
    const setup = spyOn(schema, "setupAppPwa").mockResolvedValue();
    try {
      await pwa.setup();
      expect(setup).toHaveBeenCalledWith(sql, options.schema);
      await expect(pwa.service.bootstrap()).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(reserve).toHaveBeenCalledTimes(2);
    } finally {
      setup.mockRestore();
    }
  } finally {
    reserve.mockRestore();
  }
});

test("an injected database is used for setup even when declared before platform start", async () => {
  const failure = new Error("injected reservation");
  const reserve = spyOn(injectedDb, "reserve").mockRejectedValue(failure);
  try {
    await expect(injected.setup()).rejects.toBe(failure);
    expect(reserve).toHaveBeenCalledTimes(1);
  } finally {
    reserve.mockRestore();
  }
});

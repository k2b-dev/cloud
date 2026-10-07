import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  bindProcessApplicationId,
  clearProcessApplicationId,
  getProcessApplicationId,
  getProcessPlatformPermissions,
} from "../../_internal/process-identity";
import { MailProfileInputSchema, MailProfileKeySchema } from "../../contracts/outgoing-mail";
import { mail } from "./index";
import { outgoingMailStore, resolveMailCredentials } from "./store";

const input = {
  name: "Alerts",
  fromAddress: "alerts@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15728640,
};
let previousApplicationId: ReturnType<typeof getProcessApplicationId>;
let previousPermissions: ReturnType<typeof getProcessPlatformPermissions>;
beforeEach(() => {
  previousApplicationId = getProcessApplicationId();
  previousPermissions = getProcessPlatformPermissions();
  clearProcessApplicationId();
});
afterEach(() => {
  clearProcessApplicationId();
  if (previousApplicationId !== undefined) bindProcessApplicationId(previousApplicationId, previousPermissions);
});
test("profiles fail before startup and without a declared mail permission", async () => {
  expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
  bindProcessApplicationId("inventory");
  expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
});
test("profiles use the process identity and map database failures to mail_unavailable", async () => {
  bindProcessApplicationId("inventory", ["mail:send"]);
  const read = spyOn(outgoingMailStore, "profilesForApp").mockResolvedValue([]);
  try {
    expect(await mail.profiles()).toEqual({ ok: true, data: [] });
    expect(read).toHaveBeenCalledWith("inventory");
    read.mockRejectedValue(new Error("database credential must not escape"));
    expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    expect(JSON.stringify(await mail.profiles())).not.toContain("credential");
  } finally {
    read.mockRestore();
  }
});
test("profile contract rejects invalid keys, addresses and operational bounds", () => {
  expect(MailProfileInputSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { fromAddress: "a\r\nBcc: x@example.org" },
    { smtpHost: "smtp://user:password@host" },
    { smtpPort: 0 },
    { smtpPort: 65536 },
    { pacePerMinute: 6001 },
    { pacePerMinute: 0 },
    { dailyRecipientLimit: 0 },
    { maxAttachmentBytes: 26214401 },
    { maxAttachmentBytes: 0 },
    { revision: 0 },
  ])
    expect(MailProfileInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  for (const key of ["UPPER", "-leading", "a".repeat(64), "a/b"]) expect(MailProfileKeySchema.safeParse(key).success).toBe(false);
});

test("platform send paths resolve profiles without a Core process identity or mail declaration", async () => {
  for (const appId of [undefined, "gateway-ops", "inventory"]) {
    clearProcessApplicationId();
    if (appId !== undefined) bindProcessApplicationId(appId);
    await expect(resolveMailCredentials("INVALID")).rejects.toMatchObject({ code: "invalid_profile" });
  }
});

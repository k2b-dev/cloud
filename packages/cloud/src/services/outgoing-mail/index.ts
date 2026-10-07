import { fail, ok, type Result } from "@k2b/stdlib";
import { getProcessApplicationId, getProcessPlatformPermissions } from "../../_internal/process-identity";
import type { MailProfile } from "../../contracts/outgoing-mail";
import { outgoingMailStore } from "./store";

export const mail = {
  async profiles(): Promise<Result<MailProfile[]>> {
    const appId = getProcessApplicationId();
    if (!appId)
      return fail({ code: "mail_unavailable", message: "Start the application before reading outgoing mail profiles.", status: 500 });
    if (!getProcessPlatformPermissions().includes("mail:send"))
      return fail({ code: "mail_not_declared", message: 'Declare platformPermissions: ["mail:send"].', status: 403 });
    try {
      return ok(await outgoingMailStore.profilesForApp(appId));
    } catch {
      return fail({ code: "mail_unavailable", message: "Outgoing mail profiles are unavailable.", status: 500 });
    }
  },
};

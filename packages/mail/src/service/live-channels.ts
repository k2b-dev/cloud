import type { LiveViewer } from "@k2b/cloud/events";
import { hasPermission } from "@k2b/cloud/server";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { getMailboxPermissions } from "./access";
import { resolvePublicId } from "./public-resources";

/** `mailbox` follows one mailbox; its readers are decided like the Mail API's, with one query for all of them. */
export const mailLiveChannels = {
  mailbox: {
    scope: z.object({ mailbox: ResourceShortIdSchema }).strict(),
    keys: async ({ mailbox }: { mailbox: string }) => {
      const mailboxId = await resolvePublicId("mailboxes", mailbox);
      return mailboxId ? [mailboxId] : null;
    },
    authorize: async (mailboxId: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
      const permissions = await getMailboxPermissions(mailboxId, viewers);
      return new Set(viewers.filter((_, position) => hasPermission(permissions[position] ?? "none", "read")).map((viewer) => viewer.id));
    },
  },
};

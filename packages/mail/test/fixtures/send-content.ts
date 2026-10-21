import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { actorRefFromRequest, type MailRequestContext } from "../../src/service/auth";
import { loadSendContent } from "../../src/service/send-content";

/** Prepare only the content precondition; the service under test must still authorize the actual command. */
export const reviewedDraftContentHash = async (context: MailRequestContext, mailboxId: string, draftId: string, revision: number) =>
  unwrap(await loadSendContent({ db: sql, mailboxId, draftId, expectedRevision: revision, actor: actorRefFromRequest(context) }))
    .contentHash;

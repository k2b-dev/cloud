import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { mailFocusViewSchema, ResourceShortIdSchema } from "../contracts";
import type { MailRequestContext } from "../service";
import { focus, mailboxes } from "../service";
import { localizeMailError } from "../service/error-messages";
import { loadMailboxConversationDetail } from "../service/workspace";
import { readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import MailOverview from "./MailOverview.island";
import { mailPageMessages } from "./pages-messages";
import {
  projectMailConversationDetail,
  projectSsrFocusPage,
  projectSsrMailboxList,
  resolveSsrMailboxId,
  resolveSsrMailboxResourceId,
} from "./ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return c.redirect("/");
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const workspacePreferences = readMailWorkspacePreferences(c.req.header("cookie"));
  const view = mailFocusViewSchema.catch("mine").parse(c.req.query("view"));
  const mailboxSelection = ResourceShortIdSchema.safeParse(c.req.query("mailbox"));
  const conversationSelection = ResourceShortIdSchema.safeParse(c.req.query("conversation"));
  const initialSelection =
    mailboxSelection.success && conversationSelection.success
      ? { mailboxId: mailboxSelection.data, conversationId: conversationSelection.data }
      : null;
  const initialDetail = await (async () => {
    if (!initialSelection) return null;
    const internalMailboxId = await resolveSsrMailboxId(initialSelection.mailboxId);
    if (!internalMailboxId) return null;
    const internalConversationId = await resolveSsrMailboxResourceId("conversations", internalMailboxId, initialSelection.conversationId);
    if (!internalConversationId) return null;
    const detail = await loadMailboxConversationDetail({
      context,
      mailboxId: internalMailboxId,
      conversationId: internalConversationId,
    });
    return detail ? projectMailConversationDetail(detail) : null;
  })();
  const result = await mailboxes.listMailboxes(context, 200);
  const list = result.ok
    ? result.data.filter((mailbox): mailbox is typeof mailbox & { permission: "read" | "write" | "admin" } => mailbox.permission !== "none")
    : [];
  const publicMailboxes = await projectSsrMailboxList(list);
  if (c.req.query("recent") === "true") {
    const lastMailboxId = workspacePreferences.lastMailboxId;
    if (lastMailboxId && publicMailboxes.some((mailbox) => mailbox.id === lastMailboxId)) {
      return c.redirect(`/app/mail/${lastMailboxId}`);
    }
  }
  const deletedResult = await mailboxes.listDeletedMailboxes(context, { limit: 200 });
  const deletedMailboxes = await projectSsrMailboxList(deletedResult.ok ? deletedResult.data.items : []);
  const focusResult = await focus.listFocusConversations({ context, view });
  const initialFocus = focusResult.ok
    ? await projectSsrFocusPage(focusResult.data)
    : { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null };
  return () => (
    <Layout c={c} title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbMail }]}>
      <MailOverview
        mailboxes={publicMailboxes}
        deletedMailboxes={deletedMailboxes}
        initialDeletedCursor={deletedResult.ok ? deletedResult.data.nextCursor : null}
        initialFocus={initialFocus}
        initialFocusError={focusResult.ok ? null : localizeMailError(focusResult.error, locale).message}
        initialView={view}
        initialSelection={initialSelection}
        initialDetail={initialDetail}
        initialPinnedMailboxIds={workspacePreferences.pinnedMailboxIds}
        currentUserEmail={user.mail}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});

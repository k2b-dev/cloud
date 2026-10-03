import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { requestContactDirectory } from "../contact-directory-settings";
import { mailFocusViewSchema, ResourceShortIdSchema } from "../contracts";
import type { MailRequestContext } from "../service";
import { focus, mailboxes, mailboxPreferences, publicResources } from "../service";
import { localizeMailError } from "../service/error-messages";
import { loadMailboxConversationDetail } from "../service/workspace";
import { mailWorkspaceCookie, readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
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
  const publicMailboxesPromise = (async () => {
    const result = await mailboxes.listMailboxes(context, 200);
    const list = result.ok
      ? result.data.filter(
          (mailbox): mailbox is typeof mailbox & { permission: "read" | "write" | "admin" } => mailbox.permission !== "none",
        )
      : [];
    return projectSsrMailboxList(list);
  })();
  if (c.req.query("recent") === "true") {
    const publicMailboxes = await publicMailboxesPromise;
    const lastMailboxId = workspacePreferences.lastMailboxId;
    if (lastMailboxId && publicMailboxes.some((mailbox) => mailbox.id === lastMailboxId)) {
      return c.redirect(`/app/mail/${lastMailboxId}`);
    }
  }
  const preferencesPromise = (async () => {
    // Pins and hidden mailboxes used to live in this cookie. Move this browser's lists to the
    // person once, for mailboxes they can still read, and drop them from the cookie.
    if (workspacePreferences.pinnedMailboxIds.length > 0 || workspacePreferences.hiddenMailboxIds.length > 0) {
      await mailboxPreferences.importBrowserMailboxPreferences(context, workspacePreferences);
      c.header("Set-Cookie", mailWorkspaceCookie({ ...workspacePreferences, pinnedMailboxIds: [], hiddenMailboxIds: [] }), {
        append: true,
      });
    }
    // Only readable mailboxes, at most as many as Focus excludes in one request.
    const stored = await mailboxPreferences.listMailboxPreferences(context);
    const shortIds = await publicResources.publicIds("mailboxes", [...stored.pinnedMailboxIds, ...stored.hiddenMailboxIds]);
    const toPublic = (ids: string[]) => ids.flatMap((id) => shortIds.get(id) ?? []);
    return {
      hiddenMailboxIds: stored.hiddenMailboxIds,
      publicPinnedMailboxIds: toPublic(stored.pinnedMailboxIds),
      publicHiddenMailboxIds: toPublic(stored.hiddenMailboxIds),
    };
  })();
  const [initialDetail, publicMailboxes, preferences, focusResult] = await Promise.all([
    (async () => {
      if (!initialSelection) return null;
      const internalMailboxId = await resolveSsrMailboxId(initialSelection.mailboxId);
      if (!internalMailboxId) return null;
      const internalConversationId = await resolveSsrMailboxResourceId("conversations", internalMailboxId, initialSelection.conversationId);
      if (!internalConversationId) return null;
      const detail = await loadMailboxConversationDetail({
        context,
        mailboxId: internalMailboxId,
        conversationId: internalConversationId,
        locale,
      });
      return detail ? projectMailConversationDetail(detail) : null;
    })(),
    publicMailboxesPromise,
    preferencesPromise,
    (async () => focus.listFocusConversations({ context, view, excludedMailboxIds: (await preferencesPromise).hiddenMailboxIds }))(),
  ]);
  const initialFocus = focusResult.ok
    ? await projectSsrFocusPage(focusResult.data)
    : { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null };
  return () => (
    <Layout c={c} title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbMail }]}>
      <MailOverview
        mailboxes={publicMailboxes}
        initialFocus={initialFocus}
        initialFocusError={focusResult.ok ? null : localizeMailError(focusResult.error, locale).message}
        initialView={view}
        initialSelection={initialSelection}
        initialDetail={initialDetail}
        initialPinnedMailboxIds={preferences.publicPinnedMailboxIds}
        initialHiddenMailboxIds={preferences.publicHiddenMailboxIds}
        currentUserEmail={user.mail}
        contactDirectory={requestContactDirectory(c)}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});

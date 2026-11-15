import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CodeEventCatchupStatusSchema } from "@k2b/cloud/code/events";
import { type AuthContext, getLocale, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "@k2b/cloud/server";
import { Layout, loadCodePage } from "@k2b/cloud/ssr";
import type { CodePageData } from "@k2b/cloud/ssr/code-page";
import type { Context } from "hono";
import { ssr } from "../../../../config";
import { MailCodeSelectionSchema } from "../../../../mail-code-contracts";
import type { MailRequestContext } from "../../../../service";
import { requestContactDirectory } from "../../../../service/contact-directory";
import { CountRefreshBusy } from "../../../../service/view-count-cache";
import { loadMailboxCodePageData, type MailboxCodePageData } from "../../../../service/workspace";
import MailboxCode from "../../../MailboxCode.island";
import { type MailCodeCatchUpData, mailCodeIncomingFolders, mailCodeSelectionInput, readCatchUpAddress } from "../../../MailCodeTools";
import { mailCodeMessages } from "../../../mail-code-messages";
import { loadMailSidebarData } from "../../../mail-sidebar-data";
import { mailPageMessages } from "../../../pages-messages";
import { projectMailboxCodePageData, resolveSsrMailboxId } from "../../../ssr-public-boundary";

/** What the address asks for, read once on the server so reload shows the same step: preview, operation, or stale. */
const loadCatchUp = async (c: Context, mailbox: MailboxCodePageData, code: CodePageData): Promise<MailCodeCatchUpData> => {
  const address = readCatchUpAddress(new URL(c.req.url));
  const state = code.state;
  const folders = mailCodeIncomingFolders(mailbox.folders);
  const base: MailCodeCatchUpData = {
    mailboxId: mailbox.mailbox.id,
    codeHref: code.href,
    blocked: null,
    codeId: null,
    version: null,
    folders,
    pick: { ...address.pick, folder: folders.some((folder) => folder.id === address.pick.folder) ? address.pick.folder : null },
    page: null,
    previewVersionId: null,
    selection: null,
    selectionFailed: false,
    operationId: null,
    operation: null,
    operationFailed: false,
    operationVersion: null,
    next: null,
    stale: null,
  };
  if (state.kind !== "ready" || !state.active) return { ...base, blocked: "none" };
  if (state.permission !== "editor") return { ...base, blocked: "reader" };
  if (state.code.state === "paused") return { ...base, blocked: "paused" };
  if (state.code.state !== "active") return { ...base, blocked: "none" };
  if (mailbox.access.scope !== "mailbox") return { ...base, blocked: "scope" };
  const version = { id: state.active.id, number: state.active.number };
  const ready = { ...base, codeId: state.code.id, version };
  const caller: CapabilityCaller = {
    cookie: c.req.header("cookie"),
    authorization: c.req.header("authorization"),
    locale: getLocale(c),
    signal: c.req.raw.signal,
    requestId: c.req.header("x-request-id"),
  };
  if (address.operationId) {
    const read = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.event.catchup.read",
        kind: "query",
        target: { type: "core.code", id: state.code.id },
        input: { operationId: address.operationId },
      },
      CodeEventCatchupStatusSchema,
      caller,
    );
    // An expired or unknown operation leaves the selection; a read failure keeps the step and offers "Try again".
    if (!read.ok && read.error.status === 404) return ready;
    if (!read.ok) return { ...ready, operationId: address.operationId, operationFailed: true, next: address.next };
    const operation = read.data.data;
    const old = state.versions.find((item) => item.id === operation.versionId)?.number ?? null;
    const stopped = operation.status === "failed" || operation.status === "canceled";
    return {
      ...ready,
      operationId: operation.operationId,
      operation,
      operationVersion: old,
      next: address.next,
      stale: stopped && operation.versionId !== version.id ? { version: version.number, done: operation.dispatched, old } : null,
    };
  }
  if (!address.previewVersionId) return ready;
  const page = address.page;
  // The preview was made with an earlier version: say so instead of showing it with the new one.
  if (address.previewVersionId !== version.id) return { ...ready, page, stale: { version: version.number, done: 0, old: null } };
  const selection = await invokeCapabilityWithDataSchema(
    {
      appId: "mail",
      capabilityId: "message.catchup",
      kind: "query",
      target: { type: "mail.mailbox", id: mailbox.mailbox.id },
      input: mailCodeSelectionInput(ready.pick, page),
    },
    MailCodeSelectionSchema,
    caller,
  );
  return selection.ok
    ? { ...ready, page, previewVersionId: version.id, selection: selection.data.data }
    : { ...ready, page, selectionFailed: true };
};

/** "Process existing mail": its own address beside the mailbox's Code, so reload and back return to the same step. */
export default ssr<AuthContext>(async (c) => {
  // Cold sidebar counts share the workspace count cache and may wait up to 30 seconds.
  setRequestTimeout(c, 40);
  try {
    const locale = getLocale(c);
    const { t } = mailPageMessages.resolve([locale]);
    const { t: codeText } = mailCodeMessages.resolve([locale]);
    const mailboxShortId = c.req.param("mailboxId") ?? "";
    const mailboxId = await resolveSsrMailboxId(mailboxShortId);
    if (!mailboxId) return ssr.error(c, 404);
    const actor = c.get("actor");
    const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
    if (!user) return ssr.error(c, 403);
    const context: MailRequestContext = {
      actor,
      accessSubject: c.get("accessSubject"),
      requestId: c.req.header("x-request-id") ?? null,
    };
    const [internal, sidebar] = await Promise.all([loadMailboxCodePageData(context, mailboxId), loadMailSidebarData(context)]);
    if (!internal.ok) return ssr.error(c, internal.error.status);
    const mailbox = await projectMailboxCodePageData(internal.data);
    const ref = { type: "mail.mailbox", id: mailbox.mailbox.id };
    const codeHref = `/app/mail/${mailbox.mailbox.id}/code`;
    const [code, directory] = await Promise.all([
      loadCodePage(c, {
        owner: { ref, title: mailbox.mailbox.name },
        href: codeHref,
        canManageOwner: mailbox.access.scope === "mailbox" && mailbox.access.permission === "admin",
      }),
      requestContactDirectory(c),
    ]);
    const catchUp = await loadCatchUp(c, mailbox, code);
    return () => (
      <Layout
        c={c}
        context={{ scope: ref }}
        printHint={t.printHint}
        fullPage
        workspaceSidebarCollapsible={false}
        title={[
          { title: t.breadcrumbStart, href: "/" },
          { title: t.breadcrumbMail, href: "/app/mail" },
          { title: mailbox.mailbox.name, href: `/app/mail/${mailbox.mailbox.id}` },
          { title: t.breadcrumbCode, href: codeHref },
          { title: codeText.title },
        ]}
      >
        <MailboxCode
          mailbox={mailbox}
          sidebar={sidebar}
          code={code}
          currentUserEmail={user.mail}
          contactDirectory={directory}
          catchUp={catchUp}
        />
      </Layout>
    );
  } catch (error) {
    if (error instanceof CountRefreshBusy) return ssr.error(c, 503);
    throw error;
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
});

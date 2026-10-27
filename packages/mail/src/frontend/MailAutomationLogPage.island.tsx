import { createMemo } from "solid-js";
import { apiClient } from "../api/client";
import type { MailContactDirectory } from "../contact-directory-settings";
import { automationLogItemSchema } from "../contracts";
import type { MailAutomationLogData } from "../service/automation-workspace";
import { readApiError } from "./_components/api-response";
import MailAutomationLog, { type MailAutomationLogApi, UndoNotPossible } from "./_components/MailAutomationLog";
import MailAutomationShell from "./_components/MailAutomationShell";
import type { AutomationLogFilter } from "./_components/mail-automation-log-model";

const FILTERS = new Set<string>(["all", "assignments", "uncertain", "skipped", "manual"]);
const isFilter = (value: string | null): value is AutomationLogFilter => value !== null && FILTERS.has(value);

export default function MailAutomationLogPage(props: {
  data: MailAutomationLogData;
  filter: string | null;
  q: string | null;
  currentUserEmail: string | null;
  contactDirectory: MailContactDirectory;
}) {
  const mailboxId = () => props.data.mailbox.id;
  const initialFilter = createMemo(() => (isFilter(props.filter) ? props.filter : "all"));
  const api: MailAutomationLogApi = {
    load: async ({ filter, q, before }, signal) => {
      const response = await apiClient.mailboxes[":mailboxId"]["automation-log"].$get(
        {
          param: { mailboxId: mailboxId() },
          query: { day: props.data.log.day, filter, ...(q ? { q } : {}), ...(before ? { before } : {}) },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "automation log"));
      return response.json();
    },
    detail: async (id, signal) => {
      const response = await apiClient.mailboxes[":mailboxId"]["automation-log"][":itemId"].$get(
        { param: { mailboxId: mailboxId(), itemId: id } },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "automation log entry"));
      return response.json();
    },
    undo: async (id) => {
      const response = await apiClient.mailboxes[":mailboxId"]["automation-log"][":itemId"].undo.$post({
        param: { mailboxId: mailboxId(), itemId: id },
      });
      if (response.status === 409) {
        // The conflict carries the refreshed entry: who changed the assignment and when.
        const body: unknown = await response.json();
        const parsed = automationLogItemSchema.safeParse(body && typeof body === "object" && "item" in body ? body.item : null);
        if (parsed.success) throw new UndoNotPossible(parsed.data);
        throw new Error(await readApiError(response, "undo"));
      }
      if (!response.ok) throw new Error(await readApiError(response, "undo"));
      return (await response.json()).item;
    },
    redo: async (id) => {
      const response = await apiClient.mailboxes[":mailboxId"]["automation-log"][":itemId"].redo.$post({
        param: { mailboxId: mailboxId(), itemId: id },
      });
      if (!response.ok) throw new Error(await readApiError(response, "redo"));
      return (await response.json()).item;
    },
  };
  return (
    <MailAutomationShell
      mailbox={props.data.mailbox}
      permission={props.data.permission}
      currentUserEmail={props.currentUserEmail}
      contactDirectory={props.contactDirectory}
      activePage="log"
    >
      <MailAutomationLog
        mailboxName={props.data.mailbox.name}
        timeZone={props.data.mailbox.timeZone}
        initial={props.data.log}
        initialFilter={initialFilter()}
        initialQuery={props.q ?? ""}
        canUndo={props.data.permission !== "read"}
        api={api}
        onViewChange={({ filter, q }) => {
          const url = new URL(window.location.href);
          if (filter === "all") url.searchParams.delete("filter");
          else url.searchParams.set("filter", filter);
          if (q.trim()) url.searchParams.set("q", q.trim());
          else url.searchParams.delete("q");
          window.history.replaceState(window.history.state, "", url);
        }}
      />
    </MailAutomationShell>
  );
}

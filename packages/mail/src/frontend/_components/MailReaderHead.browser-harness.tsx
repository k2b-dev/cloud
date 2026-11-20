import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { LocalTag } from "../../service/local-tags";
import MailReaderHead from "./MailReaderHead";

export type ReaderHeadHarnessOptions = { locale: "en" | "de"; tags: LocalTag[] };

declare global {
  interface Window {
    mountReaderHead: (options: ReaderHeadHarnessOptions) => void;
  }
}

// The head of an open conversation as the reader mounts it: a state chip, tags, and "+ Tag".
window.mountReaderHead = (options) => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing harness root");
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <MailReaderHead
          subject="Quarterly review"
          noSubject="(no subject)"
          flagged={false}
          flaggedLabel="Flagged"
          closeHref="/app/mail/Box001"
          onClose={() => {}}
          canWrite
          dateConfig={{ locale: options.locale, timeZone: "Europe/Berlin" }}
          workStatus="waiting"
          completionPending={false}
          onToggleCompletion={() => {}}
          actionPending={false}
          deleteBlocked={null}
          onArchive={() => {}}
          onDelete={() => {}}
          snoozedUntil={null}
          reminderDueAt={null}
          assignees={null}
          onAssign={() => {}}
          keep={null}
          keptTitle={null}
          onStopKeeping={null}
          tags={options.tags}
          onManageTags={() => {}}
          linked={{ items: [], state: "ready", retry: () => {}, enabled: false }}
          senderLabel="Ada Lovelace"
          messageCount={2}
          presence={[]}
          laterItems={() => []}
          menuItems={() => []}
          menuLabel="More conversation actions"
          hint={null}
          onHintSeen={() => {}}
        />
      </LocaleProvider>
    ),
    root,
  );
};

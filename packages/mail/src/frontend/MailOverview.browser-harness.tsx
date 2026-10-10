import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { MailFocusView } from "../contracts";
import MailOverview from "./MailOverview.island";

type OverviewProps = Parameters<typeof MailOverview>[0];

export type MailOverviewHarnessOptions = {
  initialView: MailFocusView;
  initialFocus: OverviewProps["initialFocus"];
  initialFocusError: string | null;
};

declare global {
  interface Window {
    mountMailOverview: (options: MailOverviewHarnessOptions) => void;
    /** Whether an empty state or a loading row showed while the test watched, and when. */
    focusSeen: { empty: string[]; skeleton: number };
    watchFocus: () => void;
  }
}

window.focusSeen = { empty: [], skeleton: 0 };
window.watchFocus = () => {
  window.focusSeen = { empty: [], skeleton: 0 };
  const record = () => {
    const list = document.querySelector(".mail-overview-list");
    const empty = list?.querySelector('.k2b-placeholder[data-state="empty"]');
    if (empty) window.focusSeen.empty.push(empty.textContent ?? "");
    if (list?.querySelector(".mail-focus-skeleton")) window.focusSeen.skeleton += 1;
  };
  new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
};

window.mountMailOverview = (options) => {
  render(
    () => (
      <LocaleProvider locale="en">
        <MailOverview
          mailboxes={[]}
          initialView={options.initialView}
          initialSelection={null}
          initialDetail={null}
          initialPinnedMailboxIds={[]}
          initialHiddenMailboxIds={[]}
          currentUserEmail={null}
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
          dateConfig={{ locale: "en", timeZone: "UTC" }}
          initialFocusError={options.initialFocusError}
          initialFocus={options.initialFocus}
        />
      </LocaleProvider>
    ),
    document.getElementById("root")!,
  );
};

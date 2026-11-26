import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import MailAdminKeptList, { type MailAdminKeptListProps } from "./MailAdminKeptList.island";
import MailAdminKeptRecord, { type MailAdminKeptRecordProps } from "./MailAdminKeptRecord.island";
import MailAdminMailboxes, { type MailAdminMailboxesProps } from "./MailAdminMailboxes.island";
import MailAdminSecurity, { type MailAdminSecurityProps } from "./MailAdminSecurity.island";

export type KeptHarnessOptions = { locale: "de" | "en" } & (
  | { list: MailAdminKeptListProps; record?: never; mailboxes?: never; security?: never }
  | { record: MailAdminKeptRecordProps; list?: never; mailboxes?: never; security?: never }
  | { mailboxes: MailAdminMailboxesProps; list?: never; record?: never; security?: never }
  | { security: MailAdminSecurityProps; list?: never; record?: never; mailboxes?: never }
);

declare global {
  interface Window {
    mountKept: (options: KeptHarnessOptions) => void;
  }
}

// What a Mail admin page's island renders, with the props the server would hand it (the fixture), in the request's language.
window.mountKept = (options) => {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing harness root");
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        {options.list ? (
          <MailAdminKeptList {...options.list} />
        ) : options.record ? (
          <MailAdminKeptRecord {...options.record} />
        ) : options.mailboxes ? (
          <MailAdminMailboxes {...options.mailboxes} />
        ) : options.security ? (
          <MailAdminSecurity {...options.security} />
        ) : null}
      </LocaleProvider>
    ),
    root,
  );
};

import { Dropdown } from "@k2b/ui";

/**
 * The phone head's title (Cloud flach, K12): the open mailbox's name with its app tile and a chevron, as the mockup
 * shows ("Kontakt ▾"). It opens the list of mailboxes; the sidebar, which a phone does not show, offers the same.
 */
export function MailPhoneMailboxSwitch(props: {
  current: { id: string; name: string };
  mailboxes: readonly { id: string; name: string }[];
  label: string;
  onOpen: (href: string) => void;
}) {
  return (
    <Dropdown.Root
      position="bottom-left"
      width="16rem"
      phone="sheet"
      label={props.label}
      items={props.mailboxes.map((mailbox) => ({
        label: mailbox.name,
        icon: mailbox.id === props.current.id ? "ti ti-check" : "ti ti-mail",
        action: () => props.onOpen(`/app/mail/${mailbox.id}`),
      }))}
    >
      <Dropdown.Trigger appearance="plain" class="mail-phone-mailbox" label={props.label} tooltip={false} data-mail-phone-mailbox>
        <span class="mail-phone-mailbox__tile" aria-hidden="true">
          <i class="ti ti-mail" />
        </span>
        <span class="mail-phone-mailbox__name">{props.current.name}</span>
        <i class="ti ti-chevron-down mail-phone-mailbox__chevron" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

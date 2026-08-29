import { navigateTo } from "@k2b/ssr/nav";
import { Button, useLocale } from "@k2b/ui";
import { openContactCreateFlow, type WritableContactBook } from "./ContactCreateFlow";
import { detailMessages } from "./detail-messages";

type Props = {
  writableBooks: WritableContactBook[];
  defaultBookId?: string | null;
  label?: string;
  chooseBook?: boolean;
};

export default function CreateContactButton(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const handleCreateContact = async () => {
    const result = await openContactCreateFlow({
      writableBooks: props.writableBooks,
      defaultBookId: props.defaultBookId,
      chooseBook: props.chooseBook,
      locale: locale(),
    });
    if (result) navigateTo(`/app/contacts/${result.bookId}?contact=${result.contact.id}&contactBook=${result.bookId}`);
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      class="shrink-0"
      onClick={handleCreateContact}
      aria-label={t().createContactAria}
      title={props.label ?? t().newContact}
    >
      <i class="ti ti-user-plus" aria-hidden="true" />
      {props.label ?? t().newContact}
    </Button>
  );
}

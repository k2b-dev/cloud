import { Button, type ButtonVariant, useLocale } from "@k2b/ui";
import { bookMessages } from "./book-messages";
import { createBookController } from "./create-book";

type Props = {
  class?: string;
  label?: string;
  buttonVariant?: ButtonVariant;
};

/**
 * Button that opens the create-book form. While the form is open it carries the
 * editor marker, so a live resync waits instead of reloading the page.
 */
export default function CreateBookAction(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const { createBook, busy } = createBookController();
  return (
    <Button
      variant={props.buttonVariant ?? "secondary"}
      size="sm"
      class={props.class}
      loading={busy()}
      loadingLabel={t().creatingBook}
      data-contacts-editor={busy() ? "true" : undefined}
      onClick={() => void createBook()}
      aria-label={t().createNewContactBook}
    >
      <i class="ti ti-cube-plus" aria-hidden="true" />
      {props.label ?? t().newBook}
    </Button>
  );
}

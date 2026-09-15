import { createBookController } from "./create-book";
import { AppWorkspace, Button, type ButtonVariant, useLocale } from "@k2b/ui";
import { bookMessages } from "./book-messages";

type Props = {
  class?: string;
  label?: string;
  variant?: "button" | "icon";
  buttonVariant?: ButtonVariant;
};

/**
 * Opens a modal to create a new contact book and redirects to the created book.
 */
export default function CreateBookButton(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const { createBook, busy } = createBookController();
  if (props.variant === "icon") {
    return (
      <AppWorkspace.SidebarIconAction
        icon={busy() ? "ti ti-loader-2 k2b-spin" : "ti ti-cube-plus"}
        label={props.label ?? t().newBook}
        disabled={busy()}
        onClick={() => void createBook()}
      />
    );
  }

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

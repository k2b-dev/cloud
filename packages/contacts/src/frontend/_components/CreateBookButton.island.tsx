import { AppWorkspace, type ButtonVariant, useLocale } from "@k2b/ui";
import { bookMessages } from "./book-messages";
import CreateBookAction from "./CreateBookAction";
import { createBookController } from "./create-book";

type Props = {
  class?: string;
  label?: string;
  variant?: "button" | "icon";
  buttonVariant?: ButtonVariant;
};

function CreateBookIconAction(props: { label?: string }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const { createBook, busy } = createBookController();
  return (
    <AppWorkspace.SidebarIconAction
      icon={busy() ? "ti ti-loader-2 k2b-spin" : "ti ti-cube-plus"}
      label={props.label ?? t().newBook}
      disabled={busy()}
      onClick={() => void createBook()}
    />
  );
}

/**
 * Opens a modal to create a new contact book and redirects to the created book.
 */
export default function CreateBookButton(props: Props) {
  if (props.variant === "icon") return <CreateBookIconAction label={props.label} />;
  return <CreateBookAction class={props.class} label={props.label} buttonVariant={props.buttonVariant} />;
}

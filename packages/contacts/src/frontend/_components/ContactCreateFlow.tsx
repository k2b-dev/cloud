import { dialogCore, panelDialogOptions, prompts } from "@k2b/ui";
import type { Contact } from "../../service";
import ContactUpsertForm from "./ContactUpsertForm";
import type { ContactUpsertInitialValues } from "./ContactUpsertForm.model";
import { detailMessages } from "./detail-messages";

export type WritableContactBook = {
  id: string;
  name: string;
};

type ContactCreateFlowResult = {
  bookId: string;
  contact: Contact;
};

export const openContactCreateFlow = async (options: {
  writableBooks: WritableContactBook[];
  defaultBookId?: string | null;
  chooseBook?: boolean;
  initialValues?: ContactUpsertInitialValues;
  locale: string;
}): Promise<ContactCreateFlowResult | null> => {
  const { t } = detailMessages.resolve([options.locale]);
  if (options.writableBooks.length === 0) {
    await prompts.alert(t.noWritableBookHint, {
      title: t.noWritableBook,
      icon: "ti ti-lock",
    });
    return null;
  }

  const defaultBookId =
    options.defaultBookId && options.writableBooks.some((book) => book.id === options.defaultBookId)
      ? options.defaultBookId
      : options.writableBooks[0]!.id;

  let selectedBookId = defaultBookId;
  if (options.chooseBook && options.writableBooks.length > 1) {
    const result = await prompts.form({
      title: t.chooseContactBook,
      icon: "ti ti-address-book",
      confirmText: t.continueAction,
      fields: {
        bookId: {
          type: "select",
          label: t.contactBook,
          description: t.chooseContactBookHint,
          required: true,
          default: defaultBookId,
          options: options.writableBooks.map((book) => ({
            id: book.id,
            label: book.name,
            icon: "ti ti-address-book",
          })),
        },
      },
    });
    if (!result) return null;
    selectedBookId = result.bookId;
  }

  const selectedBook = options.writableBooks.find((book) => book.id === selectedBookId);
  const contact = await dialogCore.open<Contact | undefined>(
    (close) => (
      <ContactUpsertForm
        mode="create"
        bookId={selectedBookId}
        initialValues={options.initialValues}
        title={selectedBook ? t.newContactIn({ name: selectedBook.name }) : t.newContact}
        icon="ti ti-user-plus"
        onCancel={() => close(undefined)}
        onSaved={(created) => close(created)}
      />
    ),
    panelDialogOptions,
  );

  return contact ? { bookId: selectedBookId, contact } : null;
};

import { i18n } from "@k2b/stdlib";
import { ButtonLink, Placeholder, useLocale } from "@k2b/ui";

type Props = {
  title: string;
  description: string;
  icon: string;
};

export const bookUnavailableMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { backToContacts: "Back to contacts" },
    de: { backToContacts: "Zurück zu den Kontakten" },
  },
});

/** Shared recovery state for unavailable contact-book routes. */
export default function ContactBookUnavailable(props: Props) {
  const locale = useLocale();
  const t = () => bookUnavailableMessages.resolve([locale()]).t;
  return (
    <main class="mx-auto flex min-h-64 max-w-md items-center px-3">
      <Placeholder
        state="error"
        variant="panel"
        surface="paper"
        title={props.title}
        description={props.description}
        icon={props.icon}
        class="w-full"
        action={
          <ButtonLink href="/app/contacts" variant="secondary" size="sm">
            {t().backToContacts}
          </ButtonLink>
        }
      />
    </main>
  );
}

import { ButtonLink, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { settingsDocumentationHref } from "../documentation";
import { settingsMessages } from "./messages";

export default function DocumentationLink(props: { base?: string; topic: string }) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  return (
    <Show when={settingsDocumentationHref(props.base, props.topic)}>
      {(href) => (
        <ButtonLink href={href()} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm" aria-label={t().documentationNewTab}>
          <i class="ti ti-book" aria-hidden="true" /> {t().documentation}
          <i class="ti ti-external-link" aria-hidden="true" />
        </ButtonLink>
      )}
    </Show>
  );
}

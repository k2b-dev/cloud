import { ButtonLink, IconButtonLink, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { settingsDocumentationHref } from "../documentation";
import { settingsMessages } from "./messages";

/**
 * The page header carries the labelled link. A section that has its own article
 * passes `section` and gets a compact icon link named after that section.
 */
export default function DocumentationLink(props: { base?: string; topic: string; section?: string }) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  return (
    <Show when={settingsDocumentationHref(props.base, props.topic)}>
      {(href) => (
        <Show
          when={props.section}
          fallback={
            <ButtonLink
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="sm"
              aria-label={t().documentationNewTab}
            >
              <i class="ti ti-book" aria-hidden="true" /> {t().documentation}
              <i class="ti ti-external-link" aria-hidden="true" />
            </ButtonLink>
          }
        >
          {(section) => (
            <IconButtonLink
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              label={t().sectionDocumentationNewTab({ section: section() })}
            >
              <i class="ti ti-book" aria-hidden="true" />
            </IconButtonLink>
          )}
        </Show>
      )}
    </Show>
  );
}

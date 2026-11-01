import { appPartSummaryText, watchAppBadges } from "@k2b/cloud/ssr/app-badges";
import { createNavigation, Navigation } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";

export type StartPart = {
  id: string;
  label: string;
  icon: string;
  href: string;
  /** The part's own description, until its summary has been read. */
  description?: string;
  /** The part's `pwa.summary` route. */
  summary?: string;
};

export type StartPartsProps = {
  parts: StartPart[];
  label: string;
  /** Every count and summary route of the page; the first reader on a page reads them all. */
  endpoints: string[];
};

/** Start's list of parts. Each row says what waits there, such as "3 unread", once the part has answered. */
export default function StartParts(props: StartPartsProps) {
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  const apps = createNavigation({
    items: () =>
      props.parts.map((part) => ({
        id: part.id,
        label: part.label,
        icon: part.icon,
        href: part.href,
        description: (part.summary && appPartSummaryText(part.summary)) || part.description,
      })),
  });
  return <Navigation navigation={apps} label={props.label} />;
}

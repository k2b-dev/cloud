import { appPartSummaryText, watchAppBadges } from "@k2b/cloud/ssr/app-badges";
import { List, Row } from "@k2b/ui/v2";
import { For, onCleanup, onMount } from "solid-js";

export type StartPart = {
  id: string;
  label: string;
  icon: string;
  href: string;
  /** The part's description when it has no live summary. */
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

/** A blank second line: a live summary fills it without changing the row's height. */
const RESERVED = " ";

/** Start's list of parts. Each row says what waits there, such as "3 unread", once the part has answered. */
export default function StartParts(props: StartPartsProps) {
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  return (
    <List label={props.label}>
      <For each={props.parts}>
        {(part) => (
          <Row
            icon={part.icon.replace(/^ti\s+ti-/, "")}
            // the server and the first browser render keep the same line; a live summary replaces it in place
            lines={[part.label, part.summary ? (appPartSummaryText(part.summary) ?? RESERVED) : (part.description ?? RESERVED)]}
            href={part.href}
          />
        )}
      </For>
    </List>
  );
}

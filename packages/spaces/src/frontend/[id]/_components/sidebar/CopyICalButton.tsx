import { clipboard } from "@k2b/stdlib/browser";
import { createSignal } from "solid-js";

/** The iCal address of a Space and its copy to the clipboard, for the Space menu; `copied` stays true for 2 s. */
export function createIcalCopy(props: { icalToken: string | null }) {
  const [copied, setCopied] = createSignal(false);

  const icalUrl = () =>
    props.icalToken
      ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/spaces/calendar/ical/${props.icalToken}.ics`
      : null;

  const handleCopy = async () => {
    const url = icalUrl();
    if (url) {
      await clipboard.copy(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return { copied, icalUrl, handleCopy };
}

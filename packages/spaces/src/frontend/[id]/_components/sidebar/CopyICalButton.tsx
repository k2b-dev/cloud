import { clipboard } from "@k2b/stdlib/browser";
import { AppWorkspace, Button } from "@k2b/ui";
import { createSignal } from "solid-js";
import { useSpaceMessages } from "../../messages";

type Props = {
  icalToken: string | null;
  variant?: "sidebar" | "chip" | "icon";
};

export default function CopyICalButton(props: Props) {
  const t = useSpaceMessages();
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

  if (!icalUrl()) return null;

  if (props.variant === "chip") {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={handleCopy}>
        <i class={`ti ${copied() ? "ti-check" : "ti-calendar-share"}`} />
        <span>{copied() ? t.copied : t.icalUrl}</span>
      </Button>
    );
  }

  if (props.variant === "icon") {
    const label = () => (copied() ? t.copiedIcalUrl : t.copyIcalUrl);
    return (
      <AppWorkspace.SidebarIconAction
        icon={`ti ${copied() ? "ti-check" : "ti-calendar-share"}`}
        label={label()}
        onClick={() => void handleCopy()}
      />
    );
  }

  return (
    <AppWorkspace.SidebarItem onClick={handleCopy} icon={copied() ? "ti ti-check" : "ti ti-calendar-share"}>
      {copied() ? t.copied : t.copyIcalUrl}
    </AppWorkspace.SidebarItem>
  );
}

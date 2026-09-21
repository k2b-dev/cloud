import { telemetryModeUrl } from "./filter";
import { browserMessages } from "./messages";
export default function ModeNav(props: { url: string; locale: string; browser?: boolean }) {
  const { t } = browserMessages.resolve([props.locale]);
  const url = new URL(props.url);
  return (
    <nav class="flex gap-3 border-b border-[var(--k2b-border)] text-xs" aria-label={t.navigation}>
      <a
        href={telemetryModeUrl(url, false)}
        aria-current={!props.browser ? "page" : undefined}
        class={`pb-2 ${!props.browser ? "border-b-2 border-current font-semibold text-primary" : "text-dimmed hover:text-primary"}`}
      >
        {t.server}
      </a>
      <a
        href={telemetryModeUrl(url, true)}
        aria-current={props.browser ? "page" : undefined}
        class={`pb-2 ${props.browser ? "border-b-2 border-current font-semibold text-primary" : "text-dimmed hover:text-primary"}`}
      >
        {t.browser}
      </a>
    </nav>
  );
}

import { InlineGuidance, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { composeFormattingMessages, describeComposeFormattingWarning } from "../../compose-formatting-messages";
import type { ComposeFormattingWarning } from "../../contracts";

/** What email leaves out of a previewed message. Place it below the preview, so the preview never moves when it appears. */
export default function MailFormattingWarnings(props: { warnings: ComposeFormattingWarning[] }) {
  const locale = useLocale();
  return (
    <Show when={props.warnings.length > 0}>
      <InlineGuidance icon="ti ti-info-circle" class="max-h-28 shrink-0 overflow-y-auto px-3 py-2">
        <p>{composeFormattingMessages.resolve([locale()]).t.title}</p>
        <ul>
          <For each={props.warnings}>{(warning) => <li>{describeComposeFormattingWarning(warning, locale())}</li>}</For>
        </ul>
      </InlineGuidance>
    </Show>
  );
}

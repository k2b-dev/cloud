import { Band, Bar, Empty, Pane, Prose, Text, Workspace } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { FaqText } from "../messages";

export type FaqReadEntry = { id: string; question: string; answer: string };

/**
 * The FAQ to read: each question with its answer as Markdown, all open, so a person scans the page and
 * finds words with the browser's search. Server-rendered only; nothing on it needs the browser.
 */
export default function FaqScreen(props: { t: FaqText; entries: readonly FaqReadEntry[] }) {
  return (
    <Workspace head={<Bar start={<Text type="body">FAQ</Text>} />}>
      <Pane label="FAQ" scrollKey="faq">
        <Show when={props.entries.length > 0} fallback={<Empty icon="help" text={props.t.noEntries} />}>
          <For each={props.entries}>
            {(entry) => (
              // k2b-ui gap: a Section title stays on one line and is clipped, but a question must be read whole (a long
              // question on the phone). Until Section titles wrap, each entry is a Band with its question as strong Text.
              <Band>
                <Text type="body" weight="strong">
                  {entry.question}
                </Text>
                <Prose markdown={entry.answer} />
              </Band>
            )}
          </For>
        </Show>
      </Pane>
    </Workspace>
  );
}

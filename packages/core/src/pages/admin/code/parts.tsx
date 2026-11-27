import { Bar, Chip, Empty, Failed, Path, Text, useLocale } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import type { CodeAdminCode } from "../../../code/admin";
import StateWord from "../_area/StateWord";
import { type CodeAreaQuery, type CodeAreaSection, codeAreaHref } from "./area";
import { statusText } from "./data";
import { type CodeAdminMessages, codeAdminMessages } from "./messages";

export const useCodeText = (): (() => CodeAdminMessages) => {
  const locale = useLocale();
  return () => codeAdminMessages.resolve([locale()]).t;
};

/** The head of a Code section: where it stands ("Code › Freigaben") and its deeds. */
export function CodeHead(props: { section: CodeAreaSection; start?: JSX.Element; end?: JSX.Element }) {
  const t = useCodeText();
  return (
    <Bar
      start={
        props.start ?? (
          <Path label={t().area} items={[{ label: t().area, href: codeAreaHref({}) }, { label: t().sectionLabel({ s: props.section }) }]} />
        )
      }
      end={props.end}
    />
  );
}

/**
 * The state of an automation: running is a neutral dot and word; waiting for an approval is yours to decide; paused
 * is a problem in its colour; a draft or a deletion is quiet (identity B, rule 7).
 */
export function CodeStatus(props: { code: Pick<CodeAdminCode, "status" | "pauseReason"> }) {
  const t = useCodeText();
  return (
    <Show
      when={props.code.status === "active"}
      fallback={
        <Show
          when={props.code.status === "waiting"}
          fallback={
            <Show when={props.code.status === "paused"} fallback={<StateWord muted>{statusText(t(), props.code)}</StateWord>}>
              <Chip status="warn">{statusText(t(), props.code)}</Chip>
            </Show>
          }
        >
          <Chip yours>{statusText(t(), props.code)}</Chip>
        </Show>
      }
    >
      <StateWord>{statusText(t(), props.code)}</StateWord>
    </Show>
  );
}

/** Data that failed to load once, in its place; the way out reloads the same address. */
export function LoadFailed(props: { text?: string }) {
  const t = useCodeText();
  return <Failed text={props.text ?? t().loadFailSub} onRetry={() => window.location.reload()} />;
}

/** An entry the address names that no longer exists, with the way back to its list. */
export function Missing(props: { text: string; back: CodeAreaQuery }) {
  const t = useCodeText();
  return <Empty icon="search-off" text={props.text} action={{ label: t().backToList, href: codeAreaHref(props.back) }} />;
}

/** One quiet sentence under the head that says what a section is for, where the section needs one. */
export function Lead(props: { children: string }) {
  return <Text muted>{props.children}</Text>;
}

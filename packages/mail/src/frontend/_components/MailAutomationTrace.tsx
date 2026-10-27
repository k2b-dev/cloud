import { Button, ButtonLink, Kbd, useLocale } from "@k2b/ui";
import { createMemo, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { formatLogEffect, formatLogReasons, formatLogTime } from "./mail-automation-log-format";
import { mailAutomationLogMessages } from "./mail-automation-log-messages";
import type { AutomationLogItem } from "./mail-automation-log-model";

const isAiRule = (item: AutomationLogItem) => item.by.kind === "rule" && item.by.ai;

function ReasonLine(props: { item: AutomationLogItem }) {
  const locale = useLocale();
  const t = createMemo(() => mailAutomationLogMessages.resolve([locale()]).t);
  return (
    <For each={formatLogReasons(props.item, t(), locale())}>
      {(part, index) => (
        <>
          {index() > 0 ? " · " : " "}
          {part.text}
          <Show when={part.ai}>
            <i class="ti ti-sparkles ml-0.5 text-[color:var(--k2b-ai-accent)]" aria-hidden="true" />
            <span class="sr-only"> ({t().aiMark})</span>
          </Show>
        </>
      )}
    </For>
  );
}

/**
 * What rules did with this conversation. The newest assignment of an AI rule leads as a note above the messages
 * (who got it, from which kind ✦, that names in the mail do not count, Undo); every rule effect also stays as a quiet
 * line below them. The AI only picked the kind; the target always came from the rule.
 */
export default function MailAutomationTrace(props: {
  items: AutomationLogItem[];
  where: "top" | "bottom";
  canWrite: boolean;
  timeZone?: string;
  /** Opens the Protokoll entry with the full chain. */
  whyHref: (item: AutomationLogItem) => string;
  /** The automation list, where the order of the rules shows. */
  orderHref: string;
  onUndo: (item: AutomationLogItem) => void;
  onAssign: () => void;
  onAssignToMe: () => void;
  busy?: boolean;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailAutomationLogMessages.resolve([locale()]).t);
  /**
   * The assignment that is current now, newest first: later skipped rules or other effects do not hide it, a later
   * manual change, assignment or undo ends it.
   */
  const lead = () => {
    for (const item of props.items) {
      const assigns = item.effects.some((effect) => effect.kind === "assign" || effect.kind === "unassign");
      if (item.outcome === "manual_change") return null;
      if (item.outcome !== "assigned" && item.outcome !== "uncertain") {
        if (assigns) return null;
        continue;
      }
      return isAiRule(item) && item.undo.state !== "done" && item.undo.state !== "not_possible" ? item : null;
    }
    return null;
  };
  // A on the note opens the assignment, like the hint on its button; never while typing or inside a dialog or menu.
  onMount(() => {
    if (props.where !== "top") return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "a" || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.isComposing) return;
      if (event.defaultPrevented || !props.canWrite || !lead()) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[role="dialog"],[role="menu"],[role="listbox"],input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      event.preventDefault();
      props.onAssign();
    };
    document.addEventListener("keydown", keydown);
    onCleanup(() => document.removeEventListener("keydown", keydown));
  });
  const target = (item: AutomationLogItem) => item.effects.find((effect) => effect.kind === "assign")?.target.name ?? "";
  const ruleName = (item: AutomationLogItem) => item.by.name;
  const time = (item: AutomationLogItem) => formatLogTime(item.at, locale(), props.timeZone);
  const did = (item: AutomationLogItem) => item.effects.map((effect) => formatLogEffect(effect, t())).join(", ");
  const sentence = (item: AutomationLogItem) => {
    if (item.outcome === "failed") return t().traceFailed({ rule: ruleName(item), time: time(item) });
    if (item.outcome === "skipped") return t().traceSkipped({ rule: ruleName(item) });
    if (item.outcome === "nobody") return t().traceNobody({ rule: ruleName(item), time: time(item) });
    if (item.by.kind === "person") return t().tracePerson({ name: item.by.name, time: time(item), what: did(item) });
    return t().traceDid({ rule: ruleName(item), time: time(item), what: did(item) });
  };

  const note = (item: AutomationLogItem): JSX.Element => (
    <section
      class="mx-auto my-3 flex w-full max-w-4xl gap-3 rounded-[0.875rem] px-4 py-3 text-sm"
      classList={{
        "bg-[var(--k2b-ai-surface)] text-cyan-950 dark:text-cyan-50": item.outcome === "uncertain",
        "bg-[var(--ui-surface-subtle)] text-primary": item.outcome !== "uncertain",
      }}
      data-mail-automation-note={item.outcome}
    >
      <i
        class={`ti mt-0.5 ${item.outcome === "uncertain" ? "ti-sparkles text-[color:var(--k2b-ai-accent)]" : "ti-bolt text-secondary"}`}
        aria-hidden="true"
      />
      <div class="flex min-w-0 flex-col gap-2">
        <p>
          <Show
            when={item.outcome === "uncertain"}
            fallback={
              <>
                <b>{t().ruleAssigned({ rule: ruleName(item), name: target(item) })}</b>
                <ReasonLine item={item} />. {t().namesDoNotCount}
              </>
            }
          >
            <b>{t().aiUncertain({ rule: ruleName(item), name: target(item) })}</b> {t().nothingElse}
          </Show>
        </p>
        <Show when={props.canWrite}>
          <div class="flex flex-wrap gap-1.5">
            <Show
              when={item.outcome === "uncertain"}
              fallback={
                <Show when={item.undo.state === "available"}>
                  <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onUndo(item)}>
                    <i class="ti ti-arrow-back-up" aria-hidden="true" /> {t().undo}
                  </Button>
                </Show>
              }
            >
              <Button size="sm" variant="secondary" onClick={props.onAssignToMe}>
                {t().assignToMe}
              </Button>
            </Show>
            <Button size="sm" variant="secondary" onClick={props.onAssign}>
              {t().assign} <Kbd keys="a" class="k2b-kbd-hint" />
            </Button>
            <Show
              when={item.outcome === "uncertain"}
              fallback={
                <ButtonLink size="sm" variant="ghost" href={props.whyHref(item)}>
                  {t().why}
                </ButtonLink>
              }
            >
              <ButtonLink size="sm" variant="ghost" href={item.by.kind === "rule" ? item.by.href : props.orderHref}>
                {t().seeKinds}
              </ButtonLink>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  );

  const line = (item: AutomationLogItem): JSX.Element => (
    <p
      class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2 py-1 text-[0.8125rem] text-dimmed"
      data-mail-automation-trace={item.outcome}
    >
      <i class={`ti ${item.by.kind === "person" ? "ti-user" : "ti-bolt"}`} aria-hidden="true" />
      <span class="min-w-0" classList={{ "line-through": item.undo.state === "done" }}>
        {sentence(item)}
        <ReasonLine item={item} />
      </span>
      <Show when={item.undo.state === "done"}>
        <span>{item.undo.at ? t().undone({ time: formatLogTime(item.undo.at, locale(), props.timeZone) }) : t().undoneShort}</span>
      </Show>
      <Show when={props.canWrite && item.undo.state === "available"}>
        <button type="button" class="text-primary underline underline-offset-2" disabled={props.busy} onClick={() => props.onUndo(item)}>
          {t().undo}
        </button>
        <span aria-hidden="true">·</span>
      </Show>
      <Show
        when={item.outcome === "skipped"}
        fallback={
          <a class="text-primary underline underline-offset-2" href={props.whyHref(item)}>
            {t().why}
          </a>
        }
      >
        <a class="text-primary underline underline-offset-2" href={props.orderHref}>
          {t().seeOrder}
        </a>
      </Show>
    </p>
  );

  return (
    <Show
      when={props.where === "top"}
      fallback={<div class="mx-auto flex w-full max-w-4xl flex-col">{<For each={props.items}>{line}</For>}</div>}
    >
      <Show when={lead()}>{(item) => note(item())}</Show>
    </Show>
  );
}

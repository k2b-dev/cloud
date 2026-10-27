import { AnchoredPopover, Button, IconButton, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import {
  AI_MODEL_CLASSES,
  type AiModelClass,
  type AiModelRequest,
  type AiModelUnavailableReason,
  type AiPeopleModels,
  aiModelClassFallbackChain,
} from "../shared/ai-models";
import { AiModelCard, type AiModelCardStop, aiModelClassLabel, aiModelClassSubtitle } from "./model-card";
import { aiModelChooserMessages } from "./model-chooser-messages";
import { AiModelIcon } from "./model-icon";

type Option = AiPeopleModels["options"][number];
export type AiModelChooserState = { status: "ready"; models: AiPeopleModels } | { status: "loading" } | { status: "error" };

/** "Budget aufgebraucht · wieder Mo., 00:00": the reason that replaces a subtitle. */
export const aiModelUnavailableText = (locale: string, reason: AiModelUnavailableReason): string => {
  const t = aiModelChooserMessages.resolve([locale]).t;
  if (reason.code === "budget_exhausted")
    return t.budget({
      time: new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(reason.resetsAt)),
    });
  if (reason.code === "key_rejected") return t.keyRejected;
  if (reason.code === "access_revoked") return t.revoked;
  return t.unavailable;
};

const optionName = (option: Option) => (option.variantLabel ? `${option.label} · ${option.variantLabel}` : option.label);

/** What a request shows: the class that answers, the option behind it, and the class it fell back from. */
export const resolveAiModelChoice = (models: AiPeopleModels, request: AiModelRequest | null) => {
  const chosen = request ?? models.effectiveDefault;
  if ("id" in chosen) {
    const option = models.options.find((entry) => entry.id === chosen.id);
    const modelClass = AI_MODEL_CLASSES.find(
      (entry) => option?.classes.includes(entry) && models.classes.some((stop) => stop.class === entry),
    );
    return { option, class: modelClass ?? null, requested: modelClass ?? null, fellBack: false };
  }
  for (const modelClass of [chosen.class, ...aiModelClassFallbackChain(chosen.class)]) {
    const stop = models.classes.find((entry) => entry.class === modelClass);
    if (stop) {
      const option = models.options.find((entry) => entry.id === stop.variantId);
      return { option, class: modelClass, requested: chosen.class, fellBack: modelClass !== chosen.class };
    }
  }
  return { option: undefined, class: null, requested: chosen.class, fellBack: false };
};

/**
 * The model in a composer: a chip of fixed width with the model's icon and the class (or the model's short name), and
 * a card with the slider over the assigned classes. The model's name in the card opens the list of every model in the
 * same panel. A person's choice is a class whenever the model belongs to one, so it follows the administration.
 */
export function AiModelChooser(props: {
  state: AiModelChooserState;
  value: AiModelRequest | null;
  onChange: (request: AiModelRequest) => void;
  onRetry?: () => void;
  /** An answer runs: the model stays as it is. */
  locked?: boolean;
  lockedReason?: string;
}): JSX.Element {
  const locale = useLocale();
  const t = () => aiModelChooserMessages.resolve([locale()]).t;
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [step, setStep] = createSignal<"card" | "list">("card");
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let chip: HTMLButtonElement | undefined;
  const sliderId = `ai-model-slider-${Math.random().toString(36).slice(2, 8)}`;

  const models = () => (props.state.status === "ready" ? props.state.models : null);
  const choice = createMemo(() => (models() ? resolveAiModelChoice(models()!, props.value) : null));
  const current = () => choice()?.option;
  const issue = () => (current()?.unavailable ? aiModelUnavailableText(locale(), current()!.unavailable!) : undefined);
  const stops = (): AiModelCardStop[] =>
    (models()?.classes ?? []).flatMap((stop) => {
      const option = models()!.options.find((entry) => entry.id === stop.variantId);
      if (!option) return [];
      const unavailable = stop.unavailable ?? option.unavailable;
      return [
        {
          class: stop.class,
          name: option.label,
          icon: option.icon,
          unavailable: unavailable ? aiModelUnavailableText(locale(), unavailable) : undefined,
        },
      ];
    });
  const single = () => (models()?.options.length ?? 0) <= 1;
  /** Classes first in their order, then every other model alphabetically; each option once. */
  const ordered = createMemo(() => {
    const all = models()?.options ?? [];
    const rank = (option: Option) => {
      const index = AI_MODEL_CLASSES.findIndex((modelClass) => option.classes.includes(modelClass));
      return index < 0 ? AI_MODEL_CLASSES.length : index;
    };
    return [...all].sort((left, right) => rank(left) - rank(right) || optionName(left).localeCompare(optionName(right), locale()));
  });
  const visible = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return ordered();
    return ordered().filter((option) => {
      const hay = [optionName(option), option.description, ...option.classes.map((modelClass) => aiModelClassLabel(locale(), modelClass))]
        .join(" ")
        .toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  });
  const subtitle = (option: Option) => {
    if (option.unavailable) return aiModelUnavailableText(locale(), option.unavailable);
    const modelClass = AI_MODEL_CLASSES.find((entry) => option.classes.includes(entry));
    return modelClass ? aiModelClassSubtitle(locale(), modelClass) : option.description;
  };

  const close = () => {
    setAnchor(null);
    setStep("card");
    setQuery("");
  };
  const choose = (option: Option) => {
    if (option.unavailable) return;
    const modelClass = AI_MODEL_CLASSES.find(
      (entry) => option.classes.includes(entry) && models()?.classes.some((stop) => stop.class === entry),
    );
    props.onChange(modelClass ? { class: modelClass } : { id: option.id });
    setStep("card");
    setQuery("");
    queueMicrotask(() => document.getElementById(sliderId)?.focus());
  };
  const openList = () => {
    const index = ordered().findIndex((option) => option.id === current()?.id);
    setActive(Math.max(0, index));
    setStep("list");
  };
  const onListKey = (event: KeyboardEvent) => {
    const list = visible();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setStep("card");
      queueMicrotask(() => document.getElementById(sliderId)?.focus());
      return;
    }
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves) {
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(list.length - 1, index + moves[event.key]!)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : list.length - 1);
    } else if (event.key === "Enter") {
      const option = list[active()];
      if (option) {
        event.preventDefault();
        choose(option);
      }
    }
  };

  const label = () => {
    if (props.state.status === "loading") return "";
    if (props.state.status === "error") return t().chipNotLoaded;
    if (!current()) return t().chipNone;
    return !single() && choice()?.class ? aiModelClassLabel(locale(), choice()!.class!) : current()!.label;
  };
  const ariaLabel = () =>
    [
      t().model,
      choice()?.class ? aiModelClassLabel(locale(), choice()!.class!) : "",
      current() ? optionName(current()!) : "",
      issue() ?? "",
    ]
      .filter(Boolean)
      .join(", ");
  const disabled = () => props.state.status !== "ready" || !current() || props.locked;
  /** The stop the card shows: the class that answers, or none for a model outside the classes ("Own choice"). */
  const cardClass = (): AiModelClass | null => {
    const modelClass = choice()?.class ?? null;
    return modelClass && stops().some((stop) => stop.class === modelClass) ? modelClass : null;
  };
  const note = () => {
    const resolved = choice();
    if (!resolved?.fellBack || !resolved.requested || !resolved.class) return undefined;
    return t().classMissing({
      chosen: aiModelClassLabel(locale(), resolved.requested),
      answers: aiModelClassLabel(locale(), resolved.class),
    });
  };

  return (
    <>
      <button
        ref={chip}
        type="button"
        class="ai-model-chip group inline-flex h-8 w-[148px] flex-none items-center justify-end border-0 bg-transparent p-0 outline-none"
        aria-haspopup={single() ? undefined : "dialog"}
        aria-expanded={single() ? undefined : anchor() !== null}
        aria-label={ariaLabel() || t().chooseModel}
        aria-busy={props.state.status === "loading" ? "true" : undefined}
        title={props.locked ? props.lockedReason : current() ? optionName(current()!) : undefined}
        disabled={disabled() || single()}
        data-tone={issue() ? "warning" : undefined}
        onClick={(event) => setAnchor(anchor() ? null : event.currentTarget)}
      >
        <span
          class="inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-[9px] px-1.5 text-[13px] text-(--k2b-text-secondary) group-hover:bg-(--k2b-surface-muted) group-hover:text-(--k2b-text) group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-(--k2b-focus-ring) group-aria-expanded:bg-(--k2b-surface-muted) group-disabled:opacity-55 group-disabled:group-hover:bg-transparent"
          classList={{ "opacity-100!": single() && Boolean(current()) }}
        >
          <Show
            when={props.state.status !== "loading"}
            fallback={
              <>
                <span class="size-5 animate-pulse rounded-[6px] bg-(--k2b-surface-muted)" />
                <span class="h-3 w-16 animate-pulse rounded bg-(--k2b-surface-muted)" />
              </>
            }
          >
            <span class="relative inline-grid flex-none">
              <Show when={current()} fallback={<i class="ti ti-sparkles text-sm" aria-hidden="true" />}>
                {(option) => <AiModelIcon icon={option().icon} size="xs" />}
              </Show>
              <Show when={issue()}>
                <span class="absolute -top-[3px] -right-[3px] size-[9px] rounded-full bg-(--k2b-warning-text) shadow-[0_0_0_2px_var(--k2b-surface)]" />
              </Show>
            </span>
            <span class="min-w-0 truncate" classList={{ "text-(--k2b-warning-text)": Boolean(issue()) }}>
              {label()}
            </span>
            <Show when={!single()}>
              <i class="ti ti-chevron-down text-xs" aria-hidden="true" />
            </Show>
          </Show>
        </span>
      </button>
      <AnchoredPopover
        anchor={anchor()}
        onClose={close}
        label={t().chooseModel}
        align="end"
        side="above"
        width="21.25rem"
        initialFocus={() => document.getElementById(sliderId)}
      >
        <Show
          when={step() === "card"}
          fallback={
            <div class="grid" onKeyDown={onListKey}>
              <div class="flex items-center gap-1 px-2 pt-2">
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  label={t().back}
                  onClick={() => {
                    setStep("card");
                    queueMicrotask(() => document.getElementById(sliderId)?.focus());
                  }}
                >
                  <i class="ti ti-chevron-left" aria-hidden="true" />
                </IconButton>
                <span class="text-sm font-semibold">{t().allModels}</span>
              </div>
              <Show when={ordered().length >= 8 || query()}>
                <div class="px-2.5 pt-2">
                  <TextInput
                    aria-label={t().search}
                    type="search"
                    icon="ti ti-search"
                    value={query}
                    onValueChange={(value) => {
                      setQuery(value);
                      setActive(0);
                    }}
                    placeholder={t().search}
                    autofocus
                  />
                </div>
              </Show>
              <div
                class="max-h-[356px] overflow-auto overscroll-contain px-1.5 pt-1 pb-2"
                role="listbox"
                aria-label={t().chooseModel}
                tabIndex={0}
                aria-activedescendant={visible()[active()] ? `${sliderId}-o${active()}` : undefined}
              >
                <Show
                  when={visible().length}
                  fallback={
                    <div class="flex items-center justify-between gap-2 px-2 py-3 text-sm text-(--k2b-text-muted)">
                      {t().noMatch}
                      <Button type="button" variant="ghost" size="sm" onClick={() => setQuery("")}>
                        {t().clearSearch}
                      </Button>
                    </div>
                  }
                >
                  <For each={visible()}>
                    {(option, index) => (
                      <div
                        id={`${sliderId}-o${index()}`}
                        role="option"
                        aria-selected={option.id === current()?.id}
                        aria-disabled={option.unavailable ? "true" : undefined}
                        class="grid min-h-11 cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_1rem] items-center gap-2.5 rounded-lg px-2 py-1.5"
                        classList={{
                          "bg-(--k2b-surface-muted)": index() === active(),
                          "cursor-default opacity-60": Boolean(option.unavailable),
                        }}
                        onPointerMove={() => setActive(index())}
                        onClick={() => choose(option)}
                      >
                        <AiModelIcon icon={option.icon} size="xs" />
                        <span class="grid min-w-0">
                          <span class="text-[13.5px] font-medium">{optionName(option)}</span>
                          <span
                            class="text-xs"
                            classList={{
                              "text-(--k2b-text-muted)": !option.unavailable,
                              "text-(--k2b-warning-text)": Boolean(option.unavailable),
                            }}
                          >
                            {subtitle(option)}
                          </span>
                        </span>
                        <Show when={option.id === current()?.id}>
                          <i class="ti ti-check text-sm text-(--k2b-action)" aria-hidden="true" />
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          }
        >
          <div
            class="px-3.5 pt-3 pb-4"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                chip?.focus();
              }
            }}
          >
            <AiModelCard
              stops={stops()}
              value={cardClass()}
              own={current() ? { name: optionName(current()!), icon: current()!.icon, description: current()!.description } : undefined}
              issue={issue()}
              note={note()}
              onChoose={(modelClass) => props.onChange({ class: modelClass })}
              onOpenList={(models()?.options.length ?? 0) > 1 ? openList : undefined}
              sliderId={sliderId}
              size={typeof matchMedia === "function" && matchMedia("(max-width: 47.999rem)").matches ? "lg" : "md"}
            />
          </div>
        </Show>
      </AnchoredPopover>
    </>
  );
}

/**
 * The note above a composer when the chosen model cannot answer, or no model is available: what is wrong and, where
 * Balanced can answer, the one switch. It never moves the composer's controls; the host gives it a fixed place.
 */
export function AiModelNote(props: {
  state: AiModelChooserState;
  value: AiModelRequest | null;
  onChange: (request: AiModelRequest) => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => aiModelChooserMessages.resolve([locale()]).t;
  const models = () => (props.state.status === "ready" ? props.state.models : null);
  const choice = () => (models() ? resolveAiModelChoice(models()!, props.value) : null);
  const balanced = () => models()?.classes.find((stop) => stop.class === "balanced" && !stop.unavailable);
  const note = (): { tone: "info" | "warning" | "danger"; icon: string; text: string; switchable: boolean } | null => {
    const current = models();
    if (!current) return null;
    if (current.options.length === 0) return { tone: "info", icon: "ti ti-info-circle", text: t().noteNoModel, switchable: false };
    const option = choice()?.option;
    const reason = option?.unavailable;
    if (!option || !reason) return null;
    const name = optionName(option);
    const switchable = Boolean(balanced()) && choice()?.class !== "balanced";
    if (reason.code === "budget_exhausted")
      return {
        tone: "warning",
        icon: "ti ti-gauge",
        text: t().noteBudget({
          name,
          time: new Intl.DateTimeFormat(locale(), { weekday: "long", hour: "2-digit", minute: "2-digit" }).format(
            new Date(reason.resetsAt),
          ),
        }),
        switchable,
      };
    if (reason.code === "access_revoked") return { tone: "danger", icon: "ti ti-lock", text: t().noteRevoked({ name }), switchable };
    return { tone: "warning", icon: "ti ti-plug-x", text: t().noteUnavailable({ name }), switchable };
  };
  return (
    <Show when={note()}>
      {(current) => (
        <NoticeCard tone={current().tone} icon={current().icon} title={current().text} role="status">
          <Show when={current().switchable}>
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={() => props.onChange({ class: "balanced" })}>
                {t().switchTo({ name: aiModelClassLabel(locale(), "balanced") })}
              </Button>
            </div>
          </Show>
        </NoticeCard>
      )}
    </Show>
  );
}

/** Whether the chosen model holds a draft back: no model at all, a used-up budget, or a model no longer allowed. */
export const aiModelBlocksSending = (state: AiModelChooserState, value: AiModelRequest | null): boolean => {
  if (state.status !== "ready") return false;
  if (state.models.options.length === 0) return true;
  const reason = resolveAiModelChoice(state.models, value).option?.unavailable;
  return reason?.code === "budget_exhausted" || reason?.code === "access_revoked";
};

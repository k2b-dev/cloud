import { dates } from "@k2b/stdlib";
import type { ChatDecisionAnswer } from "@k2b/ui";
import { Button, Canvas, Check, Dialog, Menu, type MenuItem, Notice, Row, Text } from "@k2b/ui/v2";
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { actionPlainText } from "../ai/chat/action-card";
import { actionMessages } from "../ai/chat/action-messages";
import type { ApprovalFrameAction, ApprovalFrameProps } from "./ApprovalFrame";
import { type ApprovalPlace, ARM_DELAY_MS } from "./approval-place";

/** A v2 icon name from a v1 icon class such as `ti ti-send`. */
const iconName = (icon: string | undefined) => icon?.replace(/^ti\s+ti-/, "");

/**
 * The approval as one row of a v2 list: the question, the reason with the expiry, and where it comes from; its answer
 * at the end. The row opens the complete proposal in a v2 `Dialog`, where the person can also edit a draft and
 * remember the answer. The same answers, outcomes, and failures as `ApprovalFrame`; only the look follows the page.
 */
export function ApprovalFrameV2(props: { frame: ApprovalFrameProps; place: ApprovalPlace }): JSX.Element {
  const p = props.frame;
  const t = () => actionMessages(p.locale);
  const [pending, setPending] = createSignal<"confirm" | "secondary" | null>(null);
  const [remembered, setRemembered] = createSignal(false);
  const [detailFailure, setDetailFailure] = createSignal(false);
  const [answerFailure, setAnswerFailure] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [loadingDetails, setLoadingDetails] = createSignal(false);
  // A click meant for what stood here before must not answer a request that just appeared: answers arm late. The
  // buttons keep their look meanwhile, so nothing changes on the screen when they arm.
  const [armed, setArmed] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  let anchor: HTMLSpanElement | undefined;

  const sentence = () =>
    p.state === "loading" && !p.sentence
      ? t().frameLoading
      : typeof p.sentence === "string"
        ? p.sentence
        : actionPlainText(p.sentence ?? []);
  const reason = () => p.waiting ?? p.unavailable ?? p.reason;
  const quiet = (): JSX.Element => (detailFailure() ? t().fullReviewFailed : answerFailure() ? t().frameAnswerFailed : reason().text);
  const quietTitle = (): string | undefined => {
    const text = quiet();
    return detailFailure() || answerFailure()
      ? typeof text === "string"
        ? text
        : undefined
      : (p.quietTitle ?? (typeof text === "string" ? text : undefined));
  };
  const disabled = () => Boolean(p.waiting || p.unavailable || p.confirm?.disabled || p.confirm?.busy || pending());
  const hasDetails = () => Boolean(p.details || p.decline || p.back || p.more?.length || p.remember || p.notes?.length || p.meta?.length);
  const editing = () => p.state === "open" && p.mode === "edit";

  // k2b-ui gap: a Row has no way to keep the focus when its own action leaves (an answer turns the row into its
  // outcome). The focus returns to the row's first control instead of falling to the page.
  const restoreFocus = () => {
    const row = anchor?.closest<HTMLElement>('[data-k2-part="Row"]');
    if (!row || detailsOpen()) return;
    const active = row.ownerDocument.activeElement;
    if (active && active !== row.ownerDocument.body && row.ownerDocument.contains(active)) return;
    row.querySelector<HTMLElement>("button:not(:disabled), a[href]")?.focus({ preventScroll: true });
  };
  createEffect(
    on(
      () => [p.state, p.mode, p.confirm?.label] as const,
      () => queueMicrotask(restoreFocus),
      { defer: true },
    ),
  );
  // The complete proposal belongs to the open question; once it is answered (here or elsewhere) it closes.
  createEffect(
    on(
      () => p.state,
      (state, previous) => {
        if (previous === "open" && state !== "open") setDetailsOpen(false);
      },
      { defer: true },
    ),
  );

  const invoke = async (answer: ChatDecisionAnswer, confirming = false) => {
    if (!armed() || pending() || p.waiting || (confirming && disabled())) return;
    setPending(confirming ? "confirm" : "secondary");
    setAnswerFailure(false);
    try {
      const choice = confirming && remembered() && p.remember && p.mode !== "edit" ? p.remember : answer;
      await choice.onSelect();
    } catch (error) {
      setAnswerFailure(true);
      p.onAnswerError?.(error);
    } finally {
      setPending(null);
    }
  };
  const showDetails = async () => {
    if (loadingDetails() || detailsOpen()) return;
    setDetailFailure(false);
    setLoadingDetails(true);
    try {
      await p.details?.load?.();
      setDetailsOpen(true);
    } catch (error) {
      setDetailFailure(true);
      p.onAnswerError?.(error);
    } finally {
      setLoadingDetails(false);
    }
  };

  const confirm = (): ApprovalFrameAction | undefined =>
    p.confirm ?? (p.state === "open" && p.more?.[0] ? { ...p.more[0], filled: false } : undefined);
  // The row's one deed: the answer, or the way back to an open question after a failure. A draft that is still being
  // edited moves on in the complete proposal, where its fields are.
  const action = () => {
    const answer = confirm();
    if (!answer) return undefined;
    if (answer.href) return { label: answer.label, icon: iconName(answer.icon), href: answer.href };
    return {
      label: answer.label,
      icon: iconName(answer.icon),
      disabled: !editing() && disabled(),
      onClick: () => {
        if (editing()) void showDetails();
        else if (answer.onSelect) void invoke({ ...answer, onSelect: answer.onSelect }, true);
      },
    };
  };
  const secondary = () => p.secondary ?? (p.state === "open" && !editing() ? p.decline : undefined);
  const directLink = () => (p.link && !p.decline && !p.back && !p.remember && !p.more?.length ? p.link : undefined);
  const menu = (): MenuItem[] => [
    ...(hasDetails() ? [{ label: t().seeEverything, icon: "list-details", onClick: () => void showDetails() }] : []),
    { label: props.place.origin.text, icon: "external-link", href: props.place.origin.href },
    ...(props.place.automation ? [{ label: props.place.automation.text, icon: "external-link", href: props.place.automation.href }] : []),
  ];
  const time = () => dates.formatDateTimeRelative(props.place.createdAt, { locale: props.place.locale });

  const foot = () => (
    <>
      <Show when={p.link}>{(link) => <Button href={link().href}>{link().label}</Button>}</Show>
      <Show when={p.state === "open"}>
        <Show when={p.back}>
          {(answer) => (
            <Button disabled={Boolean(p.waiting || pending())} onClick={() => void invoke(answer())}>
              {answer().label}
            </Button>
          )}
        </Show>
        <For each={p.more}>
          {(answer) => (
            <Button disabled={Boolean(p.waiting || pending())} onClick={() => void invoke(answer)}>
              {answer.label}
            </Button>
          )}
        </For>
        <Show when={p.decline}>
          {(answer) => (
            <Button disabled={Boolean(p.waiting || pending())} busy={pending() === "secondary"} onClick={() => void invoke(answer())}>
              {answer().label}
            </Button>
          )}
        </Show>
        <Show when={p.confirm?.onSelect && p.confirm}>
          {(answer) => (
            <Button
              variant="primary"
              busy={pending() === "confirm" || answer().busy}
              disabled={Boolean(p.waiting || p.unavailable || answer().disabled || (pending() && pending() !== "confirm"))}
              onClick={() => void invoke({ label: answer().label, onSelect: answer().onSelect! }, true)}
            >
              {answer().label}
            </Button>
          )}
        </Show>
      </Show>
    </>
  );

  return (
    <Row
      icon="shield-check"
      lines={[
        // k2b-ui gap: a Row has no polite live line; the question and its outcome are announced from these spans, as
        // the v1 frame does (an error as an alert).
        <span ref={anchor} role={p.alert ? "alert" : "status"} aria-atomic="true">
          {sentence()}
        </span>,
        <span title={quietTitle()} role={detailFailure() || answerFailure() ? "alert" : undefined}>
          {quiet()}
        </span>,
        <span>
          {props.place.automation ? `${props.place.automation.text} · ` : ""}
          {props.place.origin.text} · <time dateTime={props.place.createdAt}>{time()}</time>
        </span>,
      ]}
      onOpen={hasDetails() ? () => void showDetails() : undefined}
      action={action()}
      end={
        <>
          <Show when={secondary()}>
            {(answer) => (
              <Button
                variant="text"
                disabled={Boolean(p.waiting || pending())}
                busy={pending() === "secondary"}
                onClick={() => void invoke(answer())}
              >
                {answer().label}
              </Button>
            )}
          </Show>
          <Show when={!secondary() && directLink()}>
            {(link) => (
              <Button variant="text" href={link().href}>
                {link().label}
              </Button>
            )}
          </Show>
          <Menu label={t().approvalKind} items={menu()} />
          <Dialog
            title={p.details?.label ?? t().seeEverything}
            open={detailsOpen()}
            onOpenChange={(open) => {
              if (!open && !pending()) setDetailsOpen(false);
            }}
            foot={foot()}
          >
            <Text type="body">{p.details?.reason ?? p.reason.text}</Text>
            <Show when={p.details?.content}>
              {(content) => (
                // The proposal is the app's own drawing (blocks, a draft's fields); it keeps its renderer.
                <Canvas label={p.details?.label ?? t().seeEverything}>
                  {typeof content() === "function" ? (content() as () => JSX.Element)() : (content() as JSX.Element)}
                </Canvas>
              )}
            </Show>
            <Show when={p.details?.note}>{(note) => <Text>{note().text}</Text>}</Show>
            <For each={p.notes}>{(note) => <Text>{note.text}</Text>}</For>
            <For each={p.meta}>{(fact) => <Text muted>{fact.text}</Text>}</For>
            <Show when={p.unavailable || p.waiting}>
              {(why) => (
                <Notice tone="warn">
                  <span role="status">{why().text}</span>
                </Notice>
              )}
            </Show>
            <Show when={answerFailure()}>
              <Notice tone="bad">{t().frameAnswerFailed}</Notice>
            </Show>
            <Show when={p.state === "open" && p.mode !== "edit" ? p.remember : undefined}>
              {(remember) => (
                <Check
                  label={remember().label}
                  checked={remembered()}
                  onChange={setRemembered}
                  disabled={Boolean(p.unavailable || p.waiting || pending())}
                />
              )}
            </Show>
          </Dialog>
        </>
      }
    />
  );
}

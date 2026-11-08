import { dates } from "@k2b/stdlib";
import { Button, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ActionCard } from "../ai/chat/action-card";
import { refreshAppBadges } from "../browser/app-badges";
import { coreClient } from "../clients/core";
import { FeatCodeMark } from "../code/FeatCodeMark";
import {
  APPROVALS_PAGE_PATH,
  type ApprovalDecisionInput,
  type ApprovalListQuery,
  type ApprovalPage,
  ApprovalPageSchema,
  type PendingApproval,
} from "../contracts/approvals";
import { ApprovalCard } from "./ApprovalCard";
import { approvalCard } from "./approval-card";
import { approvalMessages } from "./messages";

/** How a decided request ends in this list. It stays in place as a receipt until the next load. */
type Outcome = "approved" | "rejected" | "elsewhere" | "gone";

/** Keep SSR and the first client render identical: the page has no reader zone of its own yet. */
const READER_TIME_ZONE = "UTC";
export type ApprovalsProps = {
  /** List the requests whose effect belongs to this app or that this app asked for. Without, every app's, grouped. */
  app?: string;
  /**
   * Only requests whose review links to this same-origin path, such as the page of the draft a send would send. Such a
   * list sits beside the resource and shows nothing while no request waits.
   */
  link?: string;
  /** The first page for the same query, loaded during SSR with `loadPendingApprovals`; without, the browser loads it. */
  initial?: ApprovalPage;
};

/** A click meant for the page must not approve a row that just appeared: decision buttons arm after this delay. */
const ARM_DELAY_MS = 500;

const useMessages = () => {
  const locale = useLocale();
  return () => approvalMessages.resolve([locale()]).t;
};

const cardInput = (item: PendingApproval) => ({
  codeVersion: item.requester.kind === "code_version",
  soleAdminNotice: item.soleAdminNotice,
  sentence: item.sentence,
  action: item.action,
  appName: item.app.name,
  appIcon: item.app.icon,
  review: item.review,
});

/** Origin of the request: the chat or Code version it waits in and when Cloud asked. The card shows the app and expiry. */
function Origin(props: { item: PendingApproval }) {
  const t = useMessages();
  const locale = useLocale();
  return (
    <p class="cloud-approval__origin">
      <i class={props.item.requester.kind === "code_version" ? "ti ti-code" : "ti ti-message-circle"} aria-hidden="true" />
      <a href={props.item.requester.href}>
        <Show when={props.item.requester.kind === "code_version"}>
          <FeatCodeMark variant="glyph" decorative class="cloud-approval__origin-mark" />
        </Show>
        {props.item.requester.kind === "code_version"
          ? props.item.requester.title
            ? t().fromCode({ title: props.item.requester.title })
            : t().fromUntitledCode
          : props.item.requester.title
            ? t().fromChat({ title: props.item.requester.title })
            : t().fromUntitledChat}
      </a>
      <span aria-hidden="true"> · </span>
      <time dateTime={props.item.createdAt}>{dates.formatDateTimeRelative(props.item.createdAt, { locale: locale() })}</time>
    </p>
  );
}

/** The outcome lines a request on this page can reach; the chat it came from shows how the Action itself ends. */
const outcomeLines = (
  card: ActionCard,
  words: ReturnType<typeof approvalMessages.resolve>["t"],
  reopen: () => void,
  codeVersion: boolean,
  reauthenticate: boolean,
) => ({
  sending: { tone: "running" as const, text: [{ kind: "text" as const, text: words.sending }] },
  approved: {
    tone: "done" as const,
    text: [{ kind: "text" as const, text: words.approvedHere }],
    detail: codeVersion ? words.versionApproved : words.continuesInChat,
  },
  rejected: { tone: "off" as const, text: card.forms.rejected, detail: words.declinedHere },
  elsewhere: { tone: "off" as const, icon: "ti ti-info-circle", text: [{ kind: "text" as const, text: words.decidedElsewhere }] },
  gone: { tone: "off" as const, icon: "ti ti-clock-x", text: [{ kind: "text" as const, text: words.gone }] },
  failed: {
    tone: "warning" as const,
    icon: "ti ti-alert-triangle",
    text: [{ kind: "text" as const, text: words.notApplied }],
    detail: reauthenticate ? words.signInAgain : words.decisionFailed,
    action: { label: words.answerAgain, onSelect: reopen },
  },
});

/** Answers that arm late, so a click meant for what was there before cannot approve a request that just appeared. */
function Armed(props: { children: JSX.Element }) {
  const [armed, setArmed] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  return <div inert={armed() ? undefined : true}>{props.children}</div>;
}

/** One request as Cloud's approval, under where it comes from. Its answers arm late, so a click meant for the page cannot approve it. */
function Row(props: {
  item: PendingApproval;
  outcome?: Outcome;
  busy: boolean;
  failed: boolean | "reauthenticate";
  decide: (input: ApprovalDecisionInput) => void;
  reopen: () => void;
}) {
  const t = useMessages();
  const locale = useLocale();
  const card = createMemo(() => approvalCard(cardInput(props.item), locale(), READER_TIME_ZONE));
  const current = () => props.outcome ?? (props.failed ? "failed" : "sending");
  const state = () => (props.outcome || props.busy || props.failed ? "decided" : "open");
  // `confirm` asks every time, whatever the stored options say.
  const remember = () =>
    props.item.remember.chat && props.item.assurance === "standard"
      ? { website: Boolean(props.item.remember.website), onSelect: () => props.decide({ approved: true, remember: "chat" }) }
      : undefined;
  return (
    <article class="cloud-approval" data-decided={props.outcome} aria-label={t().approvalFor({ title: card().questionText })}>
      <Origin item={props.item} />
      <Armed>
        <ApprovalCard
          card={card()}
          state={state()}
          timeZone={READER_TIME_ZONE}
          remember={remember()}
          expiresAt={props.item.expiresAt}
          unavailable={props.item.canApprove === false ? t().anotherAdminRequired : undefined}
          onConfirm={() => props.decide({ approved: true })}
          onDecline={() => props.decide({ approved: false })}
          // The outcome lines join the card's sentence, so they speak the stored review's language.
          outcome={{
            lines: outcomeLines(
              card(),
              approvalMessages.resolve([card().locale]).t,
              props.reopen,
              props.item.requester.kind === "code_version",
              props.failed === "reauthenticate",
            ),
            current: current(),
          }}
        />
      </Armed>
    </article>
  );
}

/**
 * Open Action approvals of the signed-in person, as every app lists and decides them. Rows that someone decides stay
 * in place, at their height, as a receipt; the list only changes when it loads again.
 */
export default function Approvals(props: ApprovalsProps) {
  const t = useMessages();
  const query = (cursor?: string): ApprovalListQuery => ({
    ...(props.app ? { app: props.app } : {}),
    ...(props.link ? { link: props.link } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const [page, setPage] = createSignal<ApprovalPage | null>(props.initial ?? null);
  const [items, setItems] = createSignal<PendingApproval[]>(props.initial?.items ?? []);
  const [outcomes, setOutcomes] = createSignal<ReadonlyMap<string, Outcome>>(new Map());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = createSignal<ReadonlyMap<string, true | "reauthenticate">>(new Map());
  const [loadError, setLoadError] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  // A failed next page keeps the rows already shown; the error sits next to the button that retries it.
  const [moreError, setMoreError] = createSignal(false);

  const fetchPage = async (cursor?: string): Promise<ApprovalPage> => {
    const response = await coreClient.approvals.$get({ query: query(cursor) });
    if (!response.ok) throw new Error(`Approvals answered ${response.status}`);
    return ApprovalPageSchema.parse(await response.json());
  };
  const reload = async () => {
    setLoadError(false);
    try {
      const next = await fetchPage();
      setPage(next);
      setItems(next.items);
      setOutcomes(new Map());
    } catch {
      setLoadError(true);
    }
  };
  const loadMore = async () => {
    const cursor = page()?.nextCursor;
    if (!cursor || loadingMore()) return;
    setLoadingMore(true);
    try {
      const next = await fetchPage(cursor);
      setMoreError(false);
      const known = new Set(items().map((item) => item.id));
      setItems([...items(), ...next.items.filter((item) => !known.has(item.id))]);
      setPage({ ...next, count: page()?.count ?? next.count });
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };
  onMount(() => {
    if (!props.initial) void reload();
  });

  const toggle = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  const decide = async (item: PendingApproval, input: ApprovalDecisionInput): Promise<void> => {
    if (busy().has(item.id) || outcomes().has(item.id)) return;
    setBusy((current) => toggle(current, item.id, true));
    setFailed((current) => {
      const next = new Map(current);
      next.delete(item.id);
      return next;
    });
    try {
      const response = await coreClient.approvals[":id"].decision.$post({ param: { id: item.id }, json: input });
      const outcome: Outcome | null = response.ok
        ? input.approved
          ? "approved"
          : "rejected"
        : response.status === 409
          ? "elsewhere"
          : response.status === 404
            ? "gone"
            : null;
      if (!outcome) {
        const error: unknown = await response.json();
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "SELF_APPROVAL" &&
          item.requester.kind === "code_version"
        ) {
          setItems((current) =>
            current.map((entry) => (entry.id === item.id ? { ...entry, canApprove: false, soleAdminNotice: undefined } : entry)),
          );
          return;
        }
        if (error && typeof error === "object" && "code" in error && error.code === "REAUTHENTICATE") {
          setFailed((current) => new Map(current).set(item.id, "reauthenticate"));
          return;
        }
        throw new Error(`Decision answered ${response.status}`);
      }
      setOutcomes((current) => new Map(current).set(item.id, outcome));
      refreshAppBadges();
    } catch {
      setFailed((current) => new Map(current).set(item.id, true));
    } finally {
      setBusy((current) => toggle(current, item.id, false));
    }
  };

  const open = createMemo(() => items().filter((item) => !outcomes().has(item.id)));
  const openCount = () => Math.max(0, (page()?.count ?? items().length) - outcomes().size);
  const rejectAll = async () => {
    const targets = open();
    if (targets.length === 0) return;
    const confirmed = await prompts.confirm(
      targets.some((item) => item.requester.kind === "code_version")
        ? t().rejectAllWithVersions
        : t().rejectAllBody({ count: targets.length }),
      {
        title: t().rejectAllTitle,
        confirmText: t().rejectAll,
        variant: "danger",
      },
    );
    // One after another: rejecting is cheap, and the list stays readable while the receipts appear.
    if (confirmed) for (const item of targets) await decide(item, { approved: false });
  };
  // Without an app filter, the Core page groups the requests by the app that owns the effect.
  const groups = createMemo(() => {
    const byApp = new Map<string, PendingApproval[]>();
    for (const item of items()) byApp.set(item.app.id, [...(byApp.get(item.app.id) ?? []), item]);
    return [...byApp.values()];
  });
  const rows = (list: PendingApproval[]) => (
    <For each={list}>
      {(item) => (
        <Row
          item={item}
          outcome={outcomes().get(item.id)}
          busy={busy().has(item.id)}
          failed={failed().get(item.id) ?? false}
          decide={(input) => void decide(item, input)}
          reopen={() =>
            setFailed((current) => {
              const next = new Map(current);
              next.delete(item.id);
              return next;
            })
          }
        />
      )}
    </For>
  );
  return (
    // A list beside one resource stays out of the way until a request for it waits.
    <Show when={!props.link || items().length > 0}>
      <section class="cloud-approvals" aria-label={t().title}>
        <Show
          when={page()}
          fallback={
            <Show when={loadError()} fallback={<Placeholder state="loading" title={t().loading} variant="panel" />}>
              <Placeholder
                state="error"
                title={t().loadFailed}
                variant="panel"
                action={
                  <Button size="sm" variant="secondary" onClick={() => void reload()}>
                    {t().retry}
                  </Button>
                }
              />
            </Show>
          }
        >
          <Show
            when={items().length > 0}
            fallback={<Placeholder icon="ti ti-circle-check" title={t().emptyTitle} description={t().emptyBody} variant="panel" />}
          >
            <Show when={!props.link}>
              <div class="cloud-approvals__toolbar">
                <span>{t().open({ count: openCount() })}</span>
                <Show when={open().length > 1}>
                  <Button size="sm" variant="ghost" onClick={() => void rejectAll()}>
                    <i class="ti ti-x" aria-hidden="true" />
                    {t().rejectAll}
                  </Button>
                </Show>
              </div>
            </Show>
            <Show
              when={props.app || props.link}
              fallback={<For each={groups()}>{(group) => <AppGroup items={group}>{rows(group)}</AppGroup>}</For>}
            >
              <div class="cloud-approvals__list">{rows(items())}</div>
            </Show>
            <Show when={page()?.nextCursor}>
              <div class="cloud-approvals__more">
                <Show when={moreError()}>
                  <p class="cloud-approvals__more-error" role="alert">
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    {t().loadMoreFailed}
                  </p>
                </Show>
                <Button size="sm" variant="link" loading={loadingMore()} onClick={() => void loadMore()}>
                  {moreError() ? t().retry : t().showMore}
                  <i class={moreError() ? "ti ti-refresh" : "ti ti-chevron-down"} aria-hidden="true" />
                </Button>
              </div>
            </Show>
          </Show>
          <Show when={(page()?.elsewhere ?? 0) > 0}>
            <p class="cloud-approvals__elsewhere">
              <span>{t().elsewhere({ count: page()?.elsewhere ?? 0 })}</span>
              <a href={APPROVALS_PAGE_PATH}>
                {t().allApprovals}
                <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </a>
            </p>
          </Show>
        </Show>
      </section>
    </Show>
  );
}

function AppGroup(props: { items: PendingApproval[]; children: JSX.Element }) {
  const app = () => props.items[0]?.app;
  return (
    <section class="cloud-approvals__group" aria-label={app()?.name}>
      <h2 class="cloud-approvals__group-title">
        <i class={app()?.icon ?? "ti ti-apps"} aria-hidden="true" />
        {app()?.name}
      </h2>
      <div class="cloud-approvals__list">{props.children}</div>
    </section>
  );
}

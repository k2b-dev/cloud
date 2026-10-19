import { dates } from "@k2b/stdlib";
import {
  Button,
  ButtonLink,
  type DropdownItem,
  dialogCore,
  MarkdownView,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  SplitButton,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { refreshAppBadges } from "../browser/app-badges";
import { capabilityReviewView } from "../capabilities/reviews";
import { coreClient } from "../clients/core";
import {
  APPROVALS_PAGE_PATH,
  type ApprovalDecisionInput,
  type ApprovalListQuery,
  type ApprovalPage,
  ApprovalPageSchema,
  type PendingApproval,
} from "../contracts/approvals";
import type { CapabilityActionLegacyReview } from "../contracts/capabilities";
import { approvalMessages } from "./messages";

/** How a decided request ends in this list. It stays in place as a receipt until the next load. */
type Outcome = "approved" | "rejected" | "elsewhere" | "gone";
/** Approved and rejected are this person's decision; the other two mean the click changed nothing. */
const decidedHere = (outcome: Outcome) => outcome === "approved" || outcome === "rejected";
/** One icon per outcome, so a rejection or a decision made elsewhere never looks like a success. */
const outcomeIcon = (outcome: Outcome, band = false) =>
  outcome === "approved"
    ? band
      ? "ti ti-circle-check"
      : "ti ti-check"
    : outcome === "rejected"
      ? band
        ? "ti ti-circle-x"
        : "ti ti-x"
      : "ti ti-info-circle";
type ReviewDetail = NonNullable<CapabilityActionLegacyReview["details"]>[number];

export type ApprovalsProps = {
  /** List the requests whose effect belongs to this app or that this app asked for. Without, every app's, grouped. */
  app?: string;
  /** Only requests whose review links to this same-origin path, such as the page of the draft a send would send. */
  link?: string;
  /** The first page for the same query, loaded during SSR with `loadPendingApprovals`; without, the browser loads it. */
  initial?: ApprovalPage;
  /**
   * `list` shows the requests with their review, a count, and an empty state. `band` shows each request as one compact
   * row above the resource it would change, and nothing when none waits.
   */
  layout?: "list" | "band";
};

/** A click meant for the page must not approve a row that just appeared: decision buttons arm after this delay. */
const ARM_DELAY_MS = 500;

const useMessages = () => {
  const locale = useLocale();
  return () => approvalMessages.resolve([locale()]).t;
};

const lines = (item: PendingApproval) =>
  item.sentence
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The first line names the app and the Action; the app already shows as the row's icon and origin. */
const approvalTitle = (item: PendingApproval): string => {
  const first = lines(item)[0] ?? item.action;
  const prefix = `${item.app.name}: `;
  return first.startsWith(prefix) && first.length > prefix.length ? first.slice(prefix.length) : first;
};

/** Without a review, the sentence's later `Label: value` lines are what the person approves. */
const sentenceFields = (item: PendingApproval) =>
  lines(item)
    .slice(1)
    .map((line) => {
      const match = /^([^:]{1,40}):\s+(.+)$/.exec(line);
      return match ? { label: match[1], value: match[2] ?? "" } : { label: null, value: line };
    });

const detailText = (detail: ReviewDetail, locale: string): string => {
  if (detail.format === "date")
    return /^\d{4}-\d{2}-\d{2}$/.test(detail.value)
      ? dates.formatDate(`${detail.value}T12:00:00.000Z`, { locale, timeZone: "UTC" })
      : dates.formatDate(detail.value, { locale });
  if (detail.format === "date-time") return dates.formatDateTime(detail.value, { locale });
  return detail.value;
};

const reviewView = (item: PendingApproval) => (item.review ? capabilityReviewView(item.review, { timeZone: "UTC" }) : undefined);
const inlineDetails = (item: PendingApproval) =>
  (reviewView(item)?.details ?? []).filter((detail) => (detail.display ?? "inline") === "inline");
const blockDetails = (item: PendingApproval) => (reviewView(item)?.details ?? []).filter((detail) => detail.display === "block");

function Fields(props: { item: PendingApproval }) {
  const locale = useLocale();
  const fields = () =>
    props.item.review
      ? inlineDetails(props.item).map((detail) => ({ label: detail.label, value: detailText(detail, locale()) }))
      : sentenceFields(props.item).filter((field): field is { label: string; value: string } => field.label !== null);
  return (
    <Show when={fields().length > 0}>
      <dl class="cloud-approval__fields">
        <For each={fields()}>
          {(field) => (
            <>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </>
          )}
        </For>
      </dl>
    </Show>
  );
}

/** The review's message, or the sentence's plain lines when the Action has no review. */
function Description(props: { item: PendingApproval }) {
  const text = () => {
    const message = reviewView(props.item)?.message.trim();
    if (message) return message === approvalTitle(props.item) ? null : message;
    const plain = sentenceFields(props.item)
      .filter((field) => field.label === null)
      .map((field) => field.value);
    return plain.length ? plain.join("\n") : null;
  };
  return (
    <Show when={text()}>
      <p class="cloud-approval__text">{text()}</p>
    </Show>
  );
}

/** Origin of the request: owning app, the chat it waits in, and when Cloud asked. The chat title is content, not frame. */
function Origin(props: { item: PendingApproval; withApp?: boolean }) {
  const t = useMessages();
  const locale = useLocale();
  return (
    <p class="cloud-approval__origin">
      <Show when={props.withApp !== false}>
        <span>{props.item.app.name}</span>
        <span aria-hidden="true"> · </span>
      </Show>
      <a href={props.item.requester.href}>
        {props.item.requester.title ? t().fromChat({ title: props.item.requester.title }) : t().fromUntitledChat}
      </a>
      <span aria-hidden="true"> · </span>
      <time dateTime={props.item.createdAt}>{dates.formatDateTimeRelative(props.item.createdAt, { locale: locale() })}</time>
    </p>
  );
}

/** "Asks every time · Expires in 23 hours", or the error of the last decision in the same place. */
function Note(props: { item: PendingApproval; outcome?: Outcome; failed?: boolean }) {
  const t = useMessages();
  const locale = useLocale();
  const text = () => {
    if (props.outcome) return decidedHere(props.outcome) ? t().decidedHere : t().notApplied;
    if (props.failed) return t().decisionFailed;
    const expires = t().expiresIn({ time: dates.formatTimeSpan(props.item.expiresAt, { locale: locale() }) });
    return props.item.assurance === "confirm" ? `${t().asksEveryTime} · ${expires}` : expires;
  };
  const icon = () =>
    props.outcome
      ? decidedHere(props.outcome)
        ? "ti ti-clock"
        : "ti ti-info-circle"
      : props.failed
        ? "ti ti-alert-circle"
        : props.item.assurance === "confirm"
          ? "ti ti-lock"
          : "ti ti-clock";
  return (
    <span
      class="cloud-approval__note"
      data-tone={props.failed && !props.outcome ? "danger" : undefined}
      role={props.failed ? "alert" : undefined}
    >
      <i class={icon()} aria-hidden="true" />
      <span title={text()}>{text()}</span>
    </span>
  );
}

function Receipt(props: { outcome: Outcome }) {
  const t = useMessages();
  const label = () => ({ approved: t().approved, rejected: t().rejected, elsewhere: t().decidedElsewhere, gone: t().gone })[props.outcome];
  return (
    <span class="cloud-approval__receipt" data-outcome={props.outcome}>
      <i class={outcomeIcon(props.outcome)} aria-hidden="true" />
      {label()}
    </span>
  );
}

/** Reject, then approve; remember options only where the request offers them, never for `confirm`. */
function Decision(props: { item: PendingApproval; busy: boolean; details?: () => void; decide: (input: ApprovalDecisionInput) => void }) {
  const t = useMessages();
  const [armed, setArmed] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const rememberItems = (): DropdownItem[] => [
    ...(props.item.remember.chat
      ? [
          {
            label: props.item.remember.website ? t().allowWebsiteForChat : t().approveForChat,
            icon: props.item.remember.website ? "ti ti-world-check" : "ti ti-message-check",
            action: () => props.decide({ approved: true, remember: "chat" }),
          },
        ]
      : []),
    ...(props.item.remember.always
      ? [{ label: t().alwaysApprove, icon: "ti ti-shield-check", action: () => props.decide({ approved: true, remember: "always" }) }]
      : []),
  ];
  return (
    // Inert, not disabled, while arming: the buttons look the same from the first frame, so nothing flickers.
    <div class="cloud-approval__actions" inert={armed() ? undefined : true}>
      <Show when={props.details}>
        {(open) => (
          <Button size="sm" variant="ghost" onClick={() => open()()}>
            {t().details}
          </Button>
        )}
      </Show>
      <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.decide({ approved: false })}>
        {t().reject}
      </Button>
      <Show
        when={props.item.assurance === "standard" && rememberItems().length > 0}
        fallback={
          <Button size="sm" variant="primary" loading={props.busy} onClick={() => props.decide({ approved: true })}>
            {t().approve}
          </Button>
        }
      >
        <SplitButton
          size="sm"
          variant="primary"
          loading={props.busy}
          menuLabel={t().moreOptions}
          menuPosition="bottom-right"
          items={rememberItems()}
          onClick={() => props.decide({ approved: true })}
        >
          {t().approve}
        </SplitButton>
      </Show>
    </div>
  );
}

function ReviewLinks(props: { item: PendingApproval }) {
  const t = useMessages();
  const title = (rel: "open" | "edit" | "status" | "preview" | "download") =>
    ({
      open: t().openIn({ app: props.item.app.name }),
      edit: t().editIn({ app: props.item.app.name }),
      status: t().statusIn({ app: props.item.app.name }),
      preview: t().preview,
      download: t().download,
    })[rel];
  return (
    <Show when={(props.item.review?.links ?? []).length > 0}>
      <nav class="cloud-approval__links" aria-label={t().approvalFor({ title: approvalTitle(props.item) })}>
        <For each={props.item.review?.links ?? []}>
          {(link) => (
            <ButtonLink href={link.href} size="sm" variant="ghost">
              <i class="ti ti-external-link" aria-hidden="true" />
              {link.title ?? title(link.rel)}
            </ButtonLink>
          )}
        </For>
      </nav>
    </Show>
  );
}

function BlockDetails(props: { item: PendingApproval; clamp?: boolean }) {
  const locale = useLocale();
  return (
    <For each={props.clamp ? blockDetails(props.item).slice(0, 1) : blockDetails(props.item)}>
      {(detail) => (
        <section class="cloud-approval__block" aria-label={detail.label}>
          <Show when={!props.clamp}>
            <h4 class="cloud-approval__label">{detail.label}</h4>
          </Show>
          <Show
            when={detail.format === "markdown" && !props.clamp}
            fallback={
              <p class="cloud-approval__quote" data-clamp={props.clamp ? "true" : undefined}>
                <span>{detailText(detail, locale())}</span>
              </p>
            }
          >
            <MarkdownView class="cloud-approval__markdown" markdown={detail.value} headingScale="compact" allowImages={false} />
          </Show>
        </section>
      )}
    </For>
  );
}

/** Opens the full request in a panel; resolves with the decision made there, if any. */
const openDetails = (item: PendingApproval, locale: string) =>
  dialogCore.open<ApprovalDecisionInput>(
    (close) => {
      const t = () => approvalMessages.resolve([locale]).t;
      return (
        <PanelDialog>
          <PanelDialog.Header
            icon={item.app.icon ?? "ti ti-shield-check"}
            title={item.app.name}
            subtitle={<Origin item={item} withApp={false} />}
            close={() => close()}
            closeLabel={t().close}
          />
          <PanelDialog.Body>
            <div class="cloud-approval__sheet">
              <h3 class="cloud-approval__sheet-title">{approvalTitle(item)}</h3>
              <Description item={item} />
              <Fields item={item} />
              <BlockDetails item={item} />
              <ReviewLinks item={item} />
              <p class="cloud-approval__callout">
                <i class="ti ti-info-circle" aria-hidden="true" />
                {t().exactlyThis}
              </p>
            </div>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <div class="cloud-approval__sheet-foot">
              <div class="cloud-approval__foot">
                <Note item={item} />
                <Decision item={item} busy={false} decide={(input) => close(input)} />
              </div>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    },
    { ...panelDialogOptions, history: true, ariaLabel: approvalMessages.resolve([locale]).t.approvalFor({ title: approvalTitle(item) }) },
  );

function Row(props: {
  item: PendingApproval;
  layout: "list" | "band";
  outcome?: Outcome;
  busy: boolean;
  failed: boolean;
  decide: (input: ApprovalDecisionInput) => void;
}) {
  const t = useMessages();
  const locale = useLocale();
  const details = async () => {
    const input = await openDetails(props.item, locale());
    if (input) props.decide(input);
  };
  const foot = () => (
    <>
      <Note item={props.item} outcome={props.outcome} failed={props.failed} />
      <Show when={props.outcome} fallback={<Decision item={props.item} busy={props.busy} details={details} decide={props.decide} />}>
        {(outcome) => (
          <div class="cloud-approval__actions">
            <Receipt outcome={outcome()} />
          </div>
        )}
      </Show>
    </>
  );
  return (
    <Show
      when={props.layout === "band"}
      fallback={
        <article class="cloud-approval" data-decided={props.outcome} aria-label={t().approvalFor({ title: approvalTitle(props.item) })}>
          <span class="cloud-approval__icon" aria-hidden="true">
            <i class={props.outcome ? outcomeIcon(props.outcome) : (props.item.app.icon ?? "ti ti-shield-check")} />
          </span>
          <div class="cloud-approval__main">
            <div class="cloud-approval__content">
              <h3 class="cloud-approval__title">{approvalTitle(props.item)}</h3>
              <Origin item={props.item} />
              <Description item={props.item} />
              <Fields item={props.item} />
              <BlockDetails item={props.item} clamp />
            </div>
            <div class="cloud-approval__foot">{foot()}</div>
          </div>
        </article>
      }
    >
      <article class="cloud-approval-band" data-decided={props.outcome} aria-label={t().approvalFor({ title: approvalTitle(props.item) })}>
        <i class={props.outcome ? outcomeIcon(props.outcome, true) : "ti ti-alert-triangle"} aria-hidden="true" />
        <div class="cloud-approval-band__text">
          <strong>{approvalTitle(props.item)}</strong>
          <Origin item={props.item} withApp={false} />
        </div>
        <div class="cloud-approval__foot">{foot()}</div>
      </article>
    </Show>
  );
}

/**
 * Open Action approvals of the signed-in person, as every app lists and decides them. Rows that someone decides stay
 * in place, at their height, as a receipt; the list only changes when it loads again.
 */
export default function Approvals(props: ApprovalsProps) {
  const t = useMessages();
  const layout = () => props.layout ?? "list";
  const query = (cursor?: string): ApprovalListQuery => ({
    ...(props.app ? { app: props.app } : {}),
    ...(props.link ? { link: props.link } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const [page, setPage] = createSignal<ApprovalPage | null>(props.initial ?? null);
  const [items, setItems] = createSignal<PendingApproval[]>(props.initial?.items ?? []);
  const [outcomes, setOutcomes] = createSignal<ReadonlyMap<string, Outcome>>(new Map());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());
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
    setMoreError(false);
    try {
      const next = await fetchPage(cursor);
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
    setFailed((current) => toggle(current, item.id, false));
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
      if (!outcome) throw new Error(`Decision answered ${response.status}`);
      setOutcomes((current) => new Map(current).set(item.id, outcome));
      refreshAppBadges();
    } catch {
      setFailed((current) => toggle(current, item.id, true));
    } finally {
      setBusy((current) => toggle(current, item.id, false));
    }
  };

  const open = createMemo(() => items().filter((item) => !outcomes().has(item.id)));
  const openCount = () => Math.max(0, (page()?.count ?? items().length) - outcomes().size);
  const rejectAll = async () => {
    const targets = open();
    if (targets.length === 0) return;
    const confirmed = await prompts.confirm(t().rejectAllBody({ count: targets.length }), {
      title: t().rejectAllTitle,
      confirmText: t().rejectAll,
      variant: "danger",
    });
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
          layout={layout()}
          outcome={outcomes().get(item.id)}
          busy={busy().has(item.id)}
          failed={failed().has(item.id)}
          decide={(input) => void decide(item, input)}
        />
      )}
    </For>
  );
  return (
    <Show
      when={layout() === "list"}
      fallback={
        <Show when={items().length > 0}>
          <div class="cloud-approval-bands">{rows(items())}</div>
        </Show>
      }
    >
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
            <div class="cloud-approvals__toolbar">
              <span>{t().open({ count: openCount() })}</span>
              <Show when={open().length > 1}>
                <Button size="sm" variant="ghost" onClick={() => void rejectAll()}>
                  <i class="ti ti-x" aria-hidden="true" />
                  {t().rejectAll}
                </Button>
              </Show>
            </div>
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
                <Button size="sm" variant="secondary" loading={loadingMore()} onClick={() => void loadMore()}>
                  {moreError() ? t().retry : t().showMore}
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

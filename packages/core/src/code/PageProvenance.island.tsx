import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { Avatar, HoverCard, LocaleProvider, Skeleton } from "@k2b/ui";
import { createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { openPageReport } from "./PageReport";
import type { CodePageLabel, CodePageOwner, CodePageProvenance, CodePageProvenanceSeed } from "./page-provenance-contracts";
import { CODE_PAGE_TREE_EVENT } from "./page-request";
import { type ProvenanceMessages, provenanceMessages } from "./provenance-messages";
import { type CodePageRef, readCodePageProvenance } from "./provenance-request";

/** Below 48rem HoverCard opens as a sheet on a tap; the same width where the footer becomes one centred line. */
const PHONE = "(max-width: 47.999rem)";

type Props = {
  /** Hosting's seed: the label for this viewer, the delivered version value, the page path, the Cloud's name. */
  provenance: CodePageProvenanceSeed;
  codeId: string;
  /** Whether the first tree has a form; CSS follows the tree after that. */
  form: boolean;
  locale: string;
};

/** What the card knows. Nothing is asked before the first opening, and nothing survives a new tree. */
type Facts =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: CodePageProvenance }
  | { kind: "failed"; message: string }
  /** The page is not the one the facts would describe anymore; only a reload helps. */
  | { kind: "stale"; message: string };

const pillLabel = (t: ProvenanceMessages, label: CodePageLabel) =>
  label.kind === "anonymous"
    ? t.selfBuilt
    : label.kind === "resource"
      ? t.pageOfResource({ type: label.type })
      : t.pageOf({ name: label.name });

/** The card's title from the loaded owner, or from the pill's label until it is loaded. */
const cardTitle = (t: ProvenanceMessages, label: CodePageLabel, owner: CodePageOwner | null | undefined) => {
  if (owner === undefined) {
    if (label.kind === "anonymous") return t.titleSelfBuilt;
    return label.kind === "resource" ? t.titleResource({ type: label.type }) : t.titleOwner({ name: label.name });
  }
  if (!owner || owner.kind === "unavailable") return t.titleSelfBuilt;
  if (owner.kind === "resource") return owner.name ? t.titleOwner({ name: owner.name }) : t.titleResource({ type: owner.type });
  return t.titleOwner({ name: owner.name });
};

/**
 * The feat/code label of a Code page: one pill in the page's footer and the card behind it. Hosting draws the pill
 * from the label in the first paint; a press or Enter opens the card, which asks for its facts once and forgets them
 * when the tree changes. Members can report the page from the card's last line.
 */
export default function PageProvenance(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <ProvenanceLabel {...props} />
    </LocaleProvider>
  );
}

function ProvenanceLabel(props: Props) {
  const t = () => provenanceMessages.resolve([props.locale]).t;
  const [facts, setFacts] = createSignal<Facts>({ kind: "idle" });
  /** A report sent from this page view: the card says "Reported" instead of the date. */
  const [reportedHere, setReportedHere] = createSignal(false);
  const [path, setPath] = createSignal(props.provenance.path);
  const ready = () => {
    const current = facts();
    return current.kind === "ready" ? current.data : undefined;
  };
  let trigger: HTMLButtonElement | undefined;
  /** Counts loads; an answer counts only while its load is the latest and the tree has not changed since. */
  let generation = 0;

  const page = (): CodePageRef => ({ codeId: props.codeId, path: path(), version: props.provenance.version });
  const load = async () => {
    const ticket = ++generation;
    setFacts({ kind: "loading" });
    const answer = await readCodePageProvenance(page());
    if (ticket !== generation) return;
    if (answer.kind === "ok") return setFacts({ kind: "ready", data: answer.data });
    const code = answer.kind === "failed" ? answer.code : undefined;
    if (code === "code_page_changed" || code === "code_route_not_found") return setFacts({ kind: "stale", message: t().changed });
    if (code === "code_sign_in_required" || code === "code_members_only") return setFacts({ kind: "stale", message: t().signedOut });
    setFacts({ kind: "failed", message: code === "code_request_rate_limit" ? t().rateLimited : t().loadFailed });
  };
  const open = () => trigger?.getAttribute("aria-expanded") === "true";

  onMount(() => {
    const host = trigger?.closest("[data-code-page-host]");
    // The tree replaced itself: the facts may describe another page or version now. An open card asks again.
    const treeChanged = () => {
      generation++;
      const prefix = `/code/${props.codeId}`;
      if (location.pathname.startsWith(prefix)) setPath(location.pathname.slice(prefix.length) || "/");
      setReportedHere(false);
      setFacts({ kind: "idle" });
      if (open()) void load();
    };
    host?.addEventListener(CODE_PAGE_TREE_EVENT, treeChanged);
    onCleanup(() => host?.removeEventListener(CODE_PAGE_TREE_EVENT, treeChanged));
  });

  const pressed = () => {
    // HoverCard has toggled the card in its own click listener before this one runs.
    queueMicrotask(() => {
      if (open() && facts().kind === "idle") void load();
    });
  };

  const report = async () => {
    // The dialog takes over from the card; the card closes first and gives the focus back to the pill.
    if (open()) trigger?.click();
    const reportedAt = await openPageReport({
      page: page(),
      locale: props.locale,
      onReported: (at) => {
        setReportedHere(true);
        setFacts((current) =>
          current.kind === "ready" ? { kind: "ready", data: { ...current.data, report: { reportedAt: at } } } : current,
        );
      },
    });
    // After a report the card opens again beside the pill and says so. On a phone the dialog's own confirmation was
    // the last sheet; the pill keeps the focus there.
    if (reportedAt && !open() && !matchMedia(PHONE).matches) trigger?.click();
    else trigger?.focus();
  };

  const date = (value: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(props.locale, options).format(new Date(value));

  return (
    <HoverCard.Trigger
      ref={(element: HTMLButtonElement) => {
        trigger = element;
      }}
      triggerClass="code-page-provenance__pill"
      class="code-page-provenance__card"
      side="above"
      align="end"
      width="23rem"
      onClick={pressed}
      title={cardTitle(t(), props.provenance.label, ready() ? ready()!.owner : undefined)}
      detail={t().inCloud({ cloud: props.provenance.cloudName })}
      content={<CardBody t={t()} locale={props.locale} facts={facts()} reportedHere={reportedHere()} retry={() => void load()} />}
      // Always a slot, so the card is a dialog that only a press opens, also while it loads or for visitors.
      actions={
        <span class="code-page-provenance__report">
          <Show when={ready()?.report}>
            {(own) => (
              <Show
                when={own().reportedAt}
                fallback={
                  <button type="button" class="code-page-provenance__link" onClick={() => void report()}>
                    {t().report}
                  </button>
                }
              >
                {(at) => (
                  <span class="code-page-provenance__reported">
                    <i class="ti ti-flag" aria-hidden="true" />
                    {reportedHere() ? t().reported : t().reportedOn({ date: date(at(), { day: "2-digit", month: "2-digit" }) })}
                  </span>
                )}
              </Show>
            )}
          </Show>
        </span>
      }
      hint={
        <>
          {t().madeWith} <FeatCodeMark />
        </>
      }
    >
      {/* Shown without a press while the page has a form. The server decides the first paint (`data-form`); CSS
          follows the tree when a form arrives or leaves later, so the pill grows to the left and nothing else moves. */}
      <span class="code-page-provenance__password" data-code-provenance-warning="" data-form={props.form ? "" : undefined}>
        <span class="code-page-provenance__segment">
          <i class="ti ti-lock" aria-hidden="true" />
          <span class="code-page-provenance__long">{t().noPasswords}</span>
          <span class="code-page-provenance__short">{t().noPasswordsShort}</span>
        </span>
        <span class="code-page-provenance__divider" aria-hidden="true" />
      </span>
      <span class="code-page-provenance__segment code-page-provenance__owner">
        <FeatCodeMark variant="glyph" size={14} decorative />
        <span class="code-page-provenance__label k2b-truncate-fade">{pillLabel(t(), props.provenance.label)}</span>
        <i class="ti ti-info-circle" aria-hidden="true" />
      </span>
    </HoverCard.Trigger>
  );
}

function CardBody(props: { t: ProvenanceMessages; locale: string; facts: Facts; reportedHere: boolean; retry: () => void }) {
  const data = () => (props.facts.kind === "ready" ? props.facts.data : undefined);
  const since = (value: string) =>
    new Intl.DateTimeFormat(props.locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
  const row = (term: string, description: JSX.Element) => (
    <>
      <dt>{term}</dt>
      <dd>{description}</dd>
    </>
  );
  return (
    <>
      <Show when={props.reportedHere && data()}>
        <p class="code-page-provenance__notice" data-tone="success" role="status">
          <i class="ti ti-circle-check" aria-hidden="true" />
          <span>{props.t.reportedNotice}</span>
        </p>
      </Show>
      <Switch
        fallback={
          // Two rows in the height of the real ones; the promises below stand at once.
          <dl class="code-page-provenance__facts" aria-busy="true" aria-label={props.t.loading}>
            {row(props.t.belongsTo, <Skeleton class="code-page-provenance__placeholder" />)}
            {row(props.t.gives, <Skeleton class="code-page-provenance__placeholder code-page-provenance__placeholder--wide" />)}
          </dl>
        }
      >
        <Match when={props.facts.kind === "failed" && props.facts}>
          {(failed) => (
            <p class="code-page-provenance__notice" data-tone="danger" role="alert">
              <i class="ti ti-cloud-off" aria-hidden="true" />
              <span>
                {failed().message}{" "}
                <button type="button" class="code-page-provenance__link" onClick={() => props.retry()}>
                  {props.t.tryAgain}
                </button>
              </span>
            </p>
          )}
        </Match>
        <Match when={props.facts.kind === "stale" && props.facts}>
          {(stale) => (
            <p class="code-page-provenance__notice" data-tone="warning" role="status">
              <i class="ti ti-refresh" aria-hidden="true" />
              <span>
                {stale().message}{" "}
                <button type="button" class="code-page-provenance__link" onClick={() => location.reload()}>
                  {props.t.reload}
                </button>
                {props.t.reloadThen}
              </span>
            </p>
          )}
        </Match>
        <Match when={data()}>
          {(facts) => (
            <dl class="code-page-provenance__facts">
              <Show when={facts().owner}>{(owner) => row(props.t.belongsTo, <Owner t={props.t} owner={owner()} />)}</Show>
              <Show when={facts().automation}>
                {(automation) => (
                  <>
                    {row(props.t.automation, props.t.automationVersion({ title: automation().title, version: automation().version }))}
                    {row(props.t.activeSince, props.t.since({ date: since(automation().activeSince) }))}
                    <Show when={automation().approvedBy}>{(name) => row(props.t.approved, props.t.approvedBy({ name: name() }))}</Show>
                  </>
                )}
              </Show>
              {row(props.t.gives, facts().gives === "account" ? props.t.givesAccount : props.t.givesNothing)}
            </dl>
          )}
        </Match>
      </Switch>
      <ul class="code-page-provenance__promises">
        <For
          each={
            [
              ["ti ti-shield-check", "checked", props.t.checkedLead, props.t.checked],
              ["ti ti-eye-off", "unchecked", props.t.uncheckedLead, props.t.unchecked],
              ["ti ti-lock", "passwords", props.t.passwordsLead, props.t.passwords],
            ] as const
          }
        >
          {([icon, kind, lead, text]) => (
            <li data-promise={kind}>
              <i class={icon} aria-hidden="true" />
              <span>
                <span class="code-page-provenance__lead">{lead}</span> {text}
              </span>
            </li>
          )}
        </For>
      </ul>
      <Show when={data()?.automation}>
        {(automation) => (
          <p class="code-page-provenance__open">
            <a href={automation().href}>{props.t.openAutomation}</a>
          </p>
        )}
      </Show>
    </>
  );
}

function Owner(props: { t: ProvenanceMessages; owner: CodePageOwner }) {
  return (
    <Switch>
      <Match when={props.owner.kind === "person" && props.owner}>
        {(person) => (
          <span class="code-page-provenance__owner-row">
            {/* The name stands beside it; the avatar adds nothing to read. */}
            <span class="code-page-provenance__avatar" aria-hidden="true">
              <Avatar name={person().name} size="xs" />
            </span>
            <span>{person().name}</span>
          </span>
        )}
      </Match>
      <Match when={props.owner.kind === "app" && props.owner}>
        {(app) => (
          <span class="code-page-provenance__owner-row">
            <i class="ti ti-apps" aria-hidden="true" />
            <span>{app().name}</span>
          </span>
        )}
      </Match>
      <Match when={props.owner.kind === "resource" && props.owner}>
        {(resource) => (
          <span class="code-page-provenance__owner-row">
            <i class="ti ti-stack-2" aria-hidden="true" />
            <span>
              {resource().name
                ? props.t.namedResource({ name: resource().name!, type: resource().type })
                : props.t.hiddenResource({ type: resource().type })}
            </span>
          </span>
        )}
      </Match>
      <Match when={props.owner.kind === "unavailable"}>
        <span class="code-page-provenance__owner-row" data-tone="warning">
          <i class="ti ti-cloud-off" aria-hidden="true" />
          <span>{props.t.ownerUnavailable}</span>
        </span>
      </Match>
    </Switch>
  );
}

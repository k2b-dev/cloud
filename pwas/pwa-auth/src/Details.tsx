import { AppApprovalClientError } from "@k2b/cloud/browser/app-approval";
import {
  CopyButton,
  DescriptionList,
  type DescriptionListItem,
  IconButton,
  InlineGuidance,
  LocaleProvider,
  PanelDialog,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type Authenticator, failure } from "./authenticator";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Binding, CloudDetails } from "./storage";

type Problem = "forbidden" | "unsupported" | "unavailable";
/** Only HTTP 400 comes from a Cloud without the `account` command; any other failure means the check did not succeed. */
const problemOf = (error: unknown): Problem => {
  if (error instanceof AppApprovalClientError && error.status === 400) return "unsupported";
  return failure(error) === "forbidden" ? "forbidden" : "unavailable";
};

/** What this device knows about one connected Cloud: the account it signs in and its own pairing. */
export function Details(props: { auth: Authenticator; binding: Binding; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [record, setRecord] = createSignal(props.binding);
  const [fresh, setFresh] = createSignal<CloudDetails>();
  const [problem, setProblem] = createSignal<Problem>();
  const [loading, setLoading] = createSignal(true);
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  onMount(async () => {
    try {
      const latest = await props.auth.stored(props.binding);
      if (latest) setRecord(latest);
    } catch {
      // The listed binding still names the Cloud and this device.
    }
    try {
      if (!props.auth.online()) throw new Error("offline");
      setFresh(await props.auth.account(props.binding, abort.signal));
    } catch (error) {
      if (!abort.signal.aborted) setProblem(problemOf(error));
    } finally {
      setLoading(false);
    }
  });
  const details = () => fresh() ?? record().details;
  const date = (value: string, time = true) =>
    new Intl.DateTimeFormat(locale(), time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(new Date(value));
  const notice = () => {
    const reason = problem();
    if (!reason) return undefined;
    if (reason === "unsupported") return t().detailsUnsupported;
    // Without a fresh answer, any account details shown are the saved copy: say when it was saved.
    const saved = details();
    if (reason === "forbidden") return saved ? `${t().forbidden} ${t().detailsSaved({ date: date(saved.checkedAt) })}` : t().forbidden;
    return saved ? t().detailsCached({ date: date(saved.checkedAt) }) : t().detailsUnreachable;
  };
  const account = (value: CloudDetails): DescriptionListItem[] => [
    {
      term: t().username,
      description: value.uid,
      action: <CopyButton text={value.uid} label={t().copyUsername} size="md" iconOnly />,
    },
    ...(value.displayName ? [{ term: t().fullName, description: value.displayName }] : []),
    { term: t().email, description: value.mail ?? <span class="auth-quiet">{t().noEmail}</span> },
  ];
  const device = (): DescriptionListItem[] => {
    const value = details();
    const approvedAt = record().approvedAt;
    return [
      { term: t().deviceName, description: value?.deviceName ?? record().name },
      ...(value ? [{ term: t().pairedSince, description: date(value.pairedAt, false) }] : []),
      ...(approvedAt ? [{ term: t().lastApproval, description: date(approvedAt) }] : []),
    ];
  };
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.binding.label}
        subtitle={props.binding.issuer}
        actions={
          <IconButton label={t().close} variant="ghost" tooltip={false} onClick={() => props.close()}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        }
      />
      <PanelDialog.Body>
        <div class="auth-details">
          <Show when={notice()}>
            {(text) => (
              <InlineGuidance tone={problem() === "forbidden" ? "warning" : "info"} role="status">
                {text()}
              </InlineGuidance>
            )}
          </Show>
          <Show when={details() || loading()}>
            <section>
              <h3>{t().accountSection}</h3>
              <Show when={details()} fallback={<InlineGuidance loading>{t().detailsLoading}</InlineGuidance>}>
                {(value) => <DescriptionList items={account(value())} />}
              </Show>
            </section>
          </Show>
          <section>
            <h3>{t().thisDevice}</h3>
            <DescriptionList items={device()} />
          </section>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export function openDetails(auth: Authenticator, binding: Binding, preferences: Preferences) {
  return openDialog(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <Details auth={auth} binding={binding} close={() => close()} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}

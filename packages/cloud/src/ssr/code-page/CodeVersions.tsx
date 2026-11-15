import { ChangeList, Placeholder } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import type { CodeVersionReadModel } from "../../contracts/code-read-model";
import { Failed } from "./CodeRuns";
import { CodeVersionApproval } from "./CodeVersionApproval";
import { type CodePageData, type CodePageInvoke, type CodePageReady, type CodePageVersion, coreQuery, VersionListSchema } from "./data";
import { Island, ModelMark, type PageText, Quiet, Row, Status, versionStatus, versionStatusWords, withQuery } from "./page-kit";

const browserInvoke: CodePageInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);
/** Unchanged access and triggers stay folded behind one line until the person asks for them. */
const SAME_FOLDED = 0;

/** What changed in access and triggers, in words; the unchanged rest is one line with "Show". */
export function VersionChanges(props: { words: CodeVersionReadModel; text: PageText }) {
  const t = props.text.t;
  const [open, setOpen] = createSignal(false);
  const changes = () => props.words.changes;
  const first = () => changes().state === "first";
  const moved = () => changes().rows.items.filter((row) => row.kind !== "same");
  const same = () => changes().rows.items.filter((row) => row.kind === "same");
  const items = () => [
    ...moved().map((row) => ({
      tone: row.kind === "remove" ? ("remove" as const) : ("add" as const),
      content: row.text,
      detail: row.note,
    })),
    ...(first() || open() || same().length <= SAME_FOLDED
      ? same().map((row) => ({ tone: "neutral" as const, icon: "ti ti-equal", content: row.text, detail: row.note }))
      : [
          {
            tone: "neutral" as const,
            icon: "ti ti-equal",
            content: (
              <>
                {t().sameRows({ count: same().length + changes().rows.more })}{" "}
                <button type="button" class="cloud-code__inline-link" onClick={() => setOpen(true)}>
                  {t().seeAll}
                </button>
              </>
            ),
          },
        ]),
  ];
  return (
    <Island title={first() ? t().firstTitle : t().changesTitle} meta={first() ? undefined : changes().text}>
      <Show when={first()}>
        <p class="cloud-code__quiet-line">{t().firstVersionNote}</p>
      </Show>
      <Show when={changes().state !== "unavailable"} fallback={<p class="cloud-code__quiet-line">{changes().text}</p>}>
        <ChangeList label={first() ? t().firstTitle : t().changesTitle} items={items()} />
      </Show>
      <p class="cloud-code__foot">{changes().assurance}</p>
    </Island>
  );
}

/** Gustav's own words about the version, marked as model text that Cloud did not check. */
export function VersionStory(props: { words: CodeVersionReadModel; text: PageText }) {
  const t = props.text.t;
  return (
    <Show when={props.words.description.text}>
      {(text) => (
        <Island
          title={t().changedBy({ name: props.text.editorName() })}
          meta={
            <Show when={props.words.description.state === "visible"}>
              <ModelMark label={t().describedNotChecked({ name: props.text.editorName() })} />
            </Show>
          }
        >
          <p class="cloud-code__story">{text()}</p>
        </Island>
      )}
    </Show>
  );
}

/** The examples Gustav tried: the count, what "successful" means, and each case with its result word. */
export function VersionExamples(props: { words: CodeVersionReadModel; text: PageText }) {
  const t = props.text.t;
  const examples = () => props.words.examples;
  return (
    <Island title={t().examplesTitle} meta={examples().summary}>
      <Show
        when={examples().items.length > 0}
        fallback={<p class="cloud-code__quiet-line">{examples().state === "none" ? t().examplesNone : examples().summary}</p>}
      >
        <p class="cloud-code__quiet-line">{examples().explanation}</p>
        <ul class="cloud-code__examples">
          <For each={examples().items}>
            {(example) => (
              <li data-state={example.state}>
                <i class={example.state === "succeeded" ? "ti ti-circle-check" : "ti ti-circle-x"} aria-hidden="true" />
                <div class="cloud-code__example-text">
                  <span class="cloud-code__row-title">{example.name}</span>
                  <span class="cloud-code__row-sub">{example.sentence}</span>
                  <Show when={example.differences.length > 0}>
                    <dl class="cloud-code__example-diff">
                      <For each={example.differences}>
                        {(difference) => (
                          <>
                            <Show when={difference.subject}>{(subject) => <dt class="cloud-code__example-subject">{subject()}</dt>}</Show>
                            <dt>{t().expected}</dt>
                            <dd>{difference.expected}</dd>
                            <dt>{t().happened}</dt>
                            <dd>{difference.actual}</dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </Show>
                </div>
                <Status
                  tone={example.state === "succeeded" ? "ok" : "danger"}
                  icon={example.state === "succeeded" ? "ti ti-circle-check" : "ti ti-circle-x"}
                  label={example.status}
                  class="cloud-code__example-status"
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Island>
  );
}

/** The versions tab (Bilder 23, 24): every version with its state, and the open one in words. */
export function CodeVersions(props: { data: CodePageData; state: CodePageReady; text: PageText; onActivate: () => void }) {
  const t = props.text.t;
  const [older, setOlder] = createSignal<CodePageVersion[]>([]);
  const [more, setMore] = createSignal(props.state.moreVersions);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const all = () => [...props.state.versions, ...older()];
  const selected = () => props.state.diff?.version ?? null;
  const words = (): CodeVersionReadModel | null => {
    const version = selected();
    if (!version) return null;
    const all = props.state.words;
    return [all?.selected, all?.proposal, all?.current].find((model) => model?.versionId === version.id) ?? null;
  };
  /** A version that waits for a decision or for switching on is shown as its approval card. */
  const approval = () => {
    const version = selected();
    if (!version || version.active) return false;
    if (version.status === "rejected" || version.status === "changes_requested" || version.status === "pending") return true;
    return version.id === props.state.waiting?.id;
  };
  const loadOlder = async () => {
    const before = all().at(-1)?.number;
    if (!before || loading()) return;
    setLoading(true);
    setFailed(false);
    const result = await browserInvoke(
      coreQuery("code.version.list", { codeId: props.state.code.id, limit: 20, before }),
      VersionListSchema,
    );
    setLoading(false);
    if (!result.ok) return setFailed(true);
    setOlder([
      ...older(),
      ...result.data.data.items.map((receipt) => ({
        id: receipt.version.id,
        number: receipt.version.number,
        status: receipt.status,
        // Names come with the page; older entries read on demand show their date only.
        createdBy: null,
        createdAt: receipt.version.createdAt,
        decisionLabel: receipt.decision?.label ?? null,
        decidedBy: null,
        active: receipt.version.id === props.state.code.activeVersionId,
      })),
    ]);
    setMore(result.data.data.nextBefore !== null);
  };
  const meta = (version: CodePageVersion) =>
    t().versionMeta({ name: version.createdBy?.name ?? null, date: props.text.short(version.createdAt), decision: version.decisionLabel });
  return (
    <div class="cloud-code__body">
      <Show when={!props.state.versionsFailed} fallback={<Failed title={t().versionsFailed} detail={t().loadKeeps} />}>
        <div class="cloud-code__md" data-phone={props.state.versionSelected ? "detail" : "list"}>
          <div class="cloud-code__list-col">
            <Island title={t().tabVersions} meta={String(all().length)} class="cloud-code__list-island">
              <ul class="cloud-code__rows cloud-code__rows--pick">
                <For each={all()}>
                  {(version) => (
                    <Row
                      href={withQuery(props.data.href, { tab: "versions", version: version.id })}
                      current={version.id === selected()?.id}
                      title={t().versionLine({ version: version.number })}
                      sub={meta(version)}
                      trail={<Status {...versionStatus(version, props.state.active, t())} reserve={versionStatusWords(t())} />}
                    />
                  )}
                </For>
              </ul>
              <Show when={failed()}>
                <p class="cloud-code__row-error" role="alert">
                  {t().olderFailed}
                </p>
              </Show>
              <Show when={more()}>
                <button type="button" class="cloud-code__more" aria-busy={loading() ? "true" : undefined} onClick={() => void loadOlder()}>
                  <i class={loading() ? "ti ti-loader-2 cloud-code__spin" : "ti ti-chevron-down"} aria-hidden="true" />
                  {t().olderVersions}
                </button>
              </Show>
            </Island>
            <Quiet icon="ti ti-terminal-2">
              {props.state.permission === "editor" ? t().pullHint : t().pullHintReader} <code>cld code pull</code>
            </Quiet>
          </div>
          <div class="cloud-code__detail-col">
            <Show
              when={selected() && words()}
              fallback={
                <Show
                  when={props.state.selectionFailed || selected()}
                  fallback={<Placeholder variant="panel" icon="ti ti-list-search" title={t().pickVersion} />}
                >
                  <Failed title={t().versionLoadFailed} detail={t().selectionKeeps} />
                </Show>
              }
            >
              <section class="cloud-code__detail" aria-labelledby="cloud-code-version-title">
                <a class="cloud-code__back" href={withQuery(props.data.href, { tab: "versions" })}>
                  <i class="ti ti-chevron-left" aria-hidden="true" />
                  {t().tabVersions}
                </a>
                <Show
                  when={approval()}
                  fallback={
                    <>
                      <header class="cloud-code__detail-head">
                        <div class="cloud-code__detail-text">
                          <h2 id="cloud-code-version-title">{t().versionLine({ version: selected()!.number })}</h2>
                          <p class="cloud-code__meta">{meta(selected()!)}</p>
                        </div>
                        <Status {...versionStatus(selected()!, props.state.active, t())} />
                      </header>
                      <VersionChanges words={words()!} text={props.text} />
                    </>
                  }
                >
                  <h2 id="cloud-code-version-title" class="sr-only">
                    {t().versionLine({ version: selected()!.number })}
                  </h2>
                  <CodeVersionApproval
                    data={props.data}
                    state={props.state}
                    version={selected()!}
                    words={words()}
                    text={props.text}
                    onActivate={props.onActivate}
                    onPage
                  />
                </Show>
                <VersionStory words={words()!} text={props.text} />
                <Show when={words()!.examples.state !== "none" || words()!.examples.items.length > 0}>
                  <VersionExamples words={words()!} text={props.text} />
                </Show>
              </section>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

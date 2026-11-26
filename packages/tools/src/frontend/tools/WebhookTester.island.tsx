import { listenPopState } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Button,
  Dialog,
  Empty,
  Failed,
  Field,
  FilterBar,
  Input,
  List,
  Menu,
  type MenuEntry,
  Notice,
  type OnNavigate,
  Pane,
  Row,
  Section,
  Select,
  StatusRow,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import ToolsScreen from "../ToolsScreen";
import { type WebhookMessages, webhookMessages } from "./webhook-messages";
import type { WebhookTesterData } from "./webhook-page-data";
import { assertOk, createWebhookQueries, type Endpoint, type WebhookLog, type WebhookQuerySource } from "./webhook-queries";
import { METHODS, type Method, receivedQuery, sentQuery } from "./webhook-query";
import { RequestPane, RequestTable, timeReader } from "./webhook-request";

const BASE = "/tools/webhooks";
const DETAIL_WIDTH = 400;
/** The data colour of an endpoint, where requests arrive. */
const ENDPOINT_COLOR = "#0f766e";

const isEndpoint = (value: unknown): value is Endpoint =>
  Boolean(value && typeof value === "object" && "id" in value && "urlPath" in value && typeof value.id === "string");

const isWebhookLog = (value: unknown): value is WebhookLog =>
  Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string");

/** An address of the tester: the view, the list's own parameters, and the open request. */
const addressOf = (mode: "receive" | "send", list: URLSearchParams, request?: string | null) => {
  const params = new URLSearchParams(mode === "send" ? "mode=send" : "");
  for (const [key, value] of list) if (key !== "mode" && key !== "request") params.append(key, value);
  if (request) params.set("request", request);
  return `${BASE}${params.size ? `?${params}` : ""}`;
};

/**
 * What both views share: the words, the time reader, the open request (in the address as `request`, opened and closed
 * in place) and the copy with its toast.
 */
const useTester = (data: WebhookTesterData) => {
  const locale = useLocale();
  const t = () => webhookMessages.resolve([locale()]).t;
  const when = createMemo(() => timeReader(locale(), data.timeZone, data.now, t()));
  const [request, setRequest] = createSignal(new URLSearchParams(data.address).get("request"));
  const toast = useToast();
  onMount(() => onCleanup(listenPopState(({ url }) => setRequest(url.searchParams.get("request")))));
  /** Opens (or with `null` closes) a request in place: one history entry, the list keeps its rows and scroll. */
  const show =
    (id: string | null): OnNavigate =>
    (navigation) => {
      history.pushState(history.state, "", navigation.href);
      setRequest(id);
    };
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(t().copied, { status: "ok" }),
      () => toast(t().copyFailed, { status: "bad" }),
    );
  return { t, when, request, setRequest, show, copy, toast };
};

const views = (t: WebhookMessages, mode: "receive" | "send") => (
  <Tabs
    label={t.views}
    items={[
      { label: t.modeReceive, icon: "inbox", href: BASE, current: mode === "receive" },
      { label: t.modeSend, icon: "send", href: `${BASE}?mode=send`, current: mode === "send" },
    ]}
  />
);

/** The search of the head: Enter applies it to the address (one history entry), Escape clears it. */
const SearchInput = (props: { t: WebhookMessages; value: string; onSearch: (text: string) => void }) => (
  <Input
    type="search"
    icon="search"
    label={props.t.searchLabel}
    placeholder={props.t.searchPlaceholder}
    value={props.value}
    onKeyDown={(event) => {
      if (event.isComposing) return;
      const input = event.currentTarget as HTMLInputElement;
      if (event.key === "Enter") props.onSearch(input.value);
      if (event.key === "Escape" && input.value) {
        input.value = "";
        props.onSearch("");
      }
    }}
  />
);

/**
 * The webhook tester on v2. Received: the person's endpoints with their addresses, then every request that came in;
 * Send: a request to any public address, then what was sent. Both lists filter by the address (FilterBar), open a
 * request beside the list, and start with the rows the server loaded.
 */
export default function WebhookTester(props: { data: WebhookTesterData }) {
  return (
    <Show when={props.data.mode === "send"} fallback={<Received data={props.data} />}>
      <Sent data={props.data} />
    </Show>
  );
}

function Received(props: { data: WebhookTesterData }) {
  const { t, when, request, setRequest, show, copy, toast } = useTester(props.data);
  const declared = (endpoints: readonly Endpoint[]) => receivedQuery(t(), endpoints);
  const [state, setState] = createSignal<ListQueryStateOf<ReturnType<typeof receivedQuery>>>(
    declared(props.data.endpoints).parse(props.data.address).state,
  );
  const source = (): WebhookQuerySource => ({
    mode: "receive",
    endpointId: state().filters.endpoint ?? null,
    method: state().filters.method ?? null,
    query: state().search ?? "",
    requestId: null,
  });
  // what the server read is the first picture; after a failed read the island reads again at once
  const queries = createWebhookQueries(
    source,
    props.data.failed ? undefined : { source: source(), endpoints: props.data.endpoints, logs: props.data.logs },
  );
  const endpoints = () => queries.endpoints.data() ?? [];
  const query = createMemo(() => declared(endpoints()));
  const logs = () => queries.logs.data() ?? [];
  const failed = () => Boolean(queries.logs.error() || queries.endpoints.error()) || (props.data.failed && !queries.logs.data());
  const listAddress = () => query().serialize(state());
  const href = (id: string | null) => addressOf("receive", listAddress(), id);
  const urlOf = (endpoint: Endpoint) => `${props.data.origin}${endpoint.urlPath}`;
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (!next) return;
    history.pushState(history.state, "", addressOf("receive", query().serialize(next), null));
    setRequest(null);
    setState(next);
  };
  const filterTo = (endpoint: Endpoint) => query().set(state(), "endpoint", endpoint.id);
  /** A press on an endpoint shows its requests (as v1 did): the filter goes into the address, in place. */
  const applyFilter =
    (next: ListQueryStateOf<ReturnType<typeof receivedQuery>>): OnNavigate =>
    (navigation) => {
      history.pushState(history.state, "", navigation.href);
      setRequest(null);
      setState(next);
    };

  // ── Writes ──
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [nameError, setNameError] = createSignal<string>();
  const create = mutation.create<Endpoint, { name: string }>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.webhooks.endpoints.$post({ json: input }, { init: { signal: abortSignal } });
      await assertOk(response);
      const endpoint: unknown = await response.json();
      if (!isEndpoint(endpoint)) throw new Error(t().unexpectedResponse);
      return endpoint;
    },
  });
  const remove = mutation.create<Endpoint, Endpoint>({
    mutation: async (endpoint, { abortSignal }) => {
      const response = await apiClient.webhooks.endpoints[":endpointId"].$delete(
        { param: { endpointId: endpoint.id } },
        { init: { signal: abortSignal } },
      );
      await assertOk(response);
      return endpoint;
    },
  });
  onCleanup(() => {
    create.abort();
    remove.abort();
  });
  const refreshAll = () => void Promise.all([queries.endpoints.refresh(), queries.logs.refresh()]).catch(() => undefined);
  const [createError, setCreateError] = createSignal<string>();
  const openCreate = () => {
    setName("");
    setNameError(undefined);
    setCreateError(undefined);
    setCreating(true);
  };
  const submitCreate = async () => {
    if (create.loading()) return;
    const value = name().trim();
    if (!value) return setNameError(t().enterEndpointName);
    const outcome = await create.mutate({ name: value });
    // the reason stands in the dialog, where the name can be changed and sent again
    if (outcome === "error") return setCreateError(create.error()?.message || t().endpointCreateFailed);
    if (outcome !== "success") return;
    setCreating(false);
    toast(t().endpointCreated, { status: "ok" });
    await queries.endpoints.invalidate().catch(() => toast(t().listNotRefreshed, { status: "bad", retry: refreshAll }));
  };
  const deleteEndpoint = async (endpoint: Endpoint) => {
    const agreed = await Dialog.confirm({
      title: t().deleteEndpointTitle({ name: endpoint.name }),
      description: t().deleteEndpointDescription,
      confirm: t().deleteConfirm,
      cancel: t().cancel,
    });
    if (!agreed) return;
    const outcome = await remove.mutate(endpoint);
    if (outcome === "error") return toast(t().endpointDeleteFailed, { status: "bad", retry: () => void deleteEndpoint(endpoint) });
    if (outcome !== "success") return;
    // a filter on the deleted endpoint ends with it
    if (state().filters.endpoint === endpoint.id) {
      const next = query().clear(state(), "endpoint");
      history.replaceState(history.state, "", addressOf("receive", query().serialize(next), request()));
      setState(next);
    }
    toast(t().endpointDeleted, { status: "ok" });
    await Promise.all([queries.endpoints.invalidate(), queries.logs.invalidate()]).catch(() =>
      toast(t().listNotRefreshed, { status: "bad", retry: refreshAll }),
    );
  };
  const deeds = (endpoint: Endpoint): MenuEntry[] => {
    const filtered = filterTo(endpoint);
    return [
      ...(filtered ? [{ label: t().showRequests, icon: "filter", href: addressOf("receive", query().serialize(filtered), null) }] : []),
      { label: t().copyUrl, icon: "copy", onClick: () => copy(urlOf(endpoint)) },
      { label: t().deleteEndpoint({ name: endpoint.name }), icon: "trash", danger: true, onClick: () => void deleteEndpoint(endpoint) },
    ];
  };
  const openLog = () => {
    const id = request();
    return id ? logs().find((log) => log.id === id) : undefined;
  };

  return (
    <ToolsScreen
      tool="webhooks"
      views={views(t(), "receive")}
      detail={request() ? DETAIL_WIDTH : undefined}
      primary={{ label: t().newEndpoint, icon: "plus", onClick: openCreate }}
      end={
        <>
          <SearchInput t={t()} value={state().search ?? ""} onSearch={search} />
          <Button variant="primary" icon="plus" onClick={openCreate}>
            {t().addEndpoint}
          </Button>
        </>
      }
    >
      <Pane.Split>
        <Pane
          label={t().requests}
          scrollKey="tools-webhooks"
          status={
            <>
              <FilterBar
                query={query()}
                state={state()}
                onChange={setState}
                icons={{ endpoint: "webhook", method: "code" }}
                results={t().requestCount({ count: logs().length })}
              />
              <RequestStatus
                t={t()}
                logs={logs()}
                direction="incoming"
                when={when()}
                loading={queries.logs.loading() || queries.logs.refreshing()}
                onRefresh={() => void queries.logs.refresh().catch(() => undefined)}
                facts={[{ value: t().endpointCount({ count: endpoints().length }) }]}
              />
            </>
          }
        >
          <Section icon="webhook" title={t().endpoints} count={endpoints().length} summary={t().endpointsSummary}>
            <Show
              when={endpoints().length > 0}
              fallback={
                <Empty icon="webhook" text={t().noEndpoints} action={{ label: t().newEndpoint, icon: "plus", onClick: openCreate }} />
              }
            >
              <List label={t().endpoints}>
                <For each={endpoints()}>
                  {(endpoint) => (
                    <Menu.Context items={deeds(endpoint)}>
                      <Row
                        icon="webhook"
                        color={ENDPOINT_COLOR}
                        lines={[endpoint.name, urlOf(endpoint)]}
                        meta={t().requestCount({ count: endpoint.requestCount })}
                        time={endpoint.lastRequestAt ? t().lastRequest({ time: when()(endpoint.lastRequestAt) }) : t().noRequestYet}
                        current={state().filters.endpoint === endpoint.id}
                        href={filterTo(endpoint) ? addressOf("receive", query().serialize(filterTo(endpoint)!), null) : undefined}
                        onNavigate={filterTo(endpoint) ? applyFilter(filterTo(endpoint)!) : undefined}
                        action={{ label: t().copyUrl, icon: "copy", onClick: () => copy(urlOf(endpoint)) }}
                        end={<Menu label={t().endpointActions({ name: endpoint.name })} items={deeds(endpoint)} />}
                      />
                    </Menu.Context>
                  )}
                </For>
              </List>
            </Show>
          </Section>
          <Show
            when={!failed()}
            fallback={
              <Failed
                text={t().loadFailed}
                onRetry={() => void Promise.all([queries.endpoints.refresh(), queries.logs.refresh()]).catch(() => undefined)}
              />
            }
          >
            <RequestTable
              label={t().requests}
              rows={logs()}
              current={request()}
              t={t()}
              when={when()}
              href={href}
              onOpen={(id) => show(id)}
              endpointOf={(log) => endpoints().find((endpoint) => endpoint.id === log.endpointId)?.name ?? t().deletedEndpoint}
              empty={
                state().search || state().filters.endpoint || state().filters.method
                  ? { icon: "filter-off", text: t().noMatches, action: { label: t().resetFilters, icon: "filter-off", href: BASE } }
                  : { icon: "inbox", text: t().emptyIncoming }
              }
            />
          </Show>
          <Band>
            <Text type="meta" muted>
              {t().dataNotice}
            </Text>
          </Band>
        </Pane>
        <Show when={request()}>
          <RequestPane
            log={openLog()}
            endpointName={endpoints().find((endpoint) => endpoint.id === openLog()?.endpointId)?.name}
            t={t()}
            when={when()}
            listLabel={t().requests}
            closeHref={href(null)}
            onClose={show(null)}
          />
        </Show>
      </Pane.Split>
      <Dialog
        title={t().newEndpoint}
        open={creating()}
        onOpenChange={setCreating}
        foot={
          <>
            <Button onClick={() => setCreating(false)}>{t().cancel}</Button>
            <Button variant="primary" icon="plus" busy={create.loading()} onClick={() => void submitCreate()}>
              {t().create}
            </Button>
          </>
        }
      >
        <Show when={createError()}>
          {(reason) => (
            <Notice tone="bad" title={t().endpointCreateFailed}>
              {reason()}
            </Notice>
          )}
        </Show>
        <Field label={t().nameLabel} hint={t().nameHint} error={nameError()} required>
          <Input
            value={name()}
            placeholder={t().namePlaceholder}
            maxLength={120}
            onInput={(value) => {
              setName(value);
              setNameError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) void submitCreate();
            }}
          />
        </Field>
      </Dialog>
    </ToolsScreen>
  );
}

/** The one statement of the list: how many requests, how many of them failed, and the way to look again. */
const RequestStatus = (props: {
  t: WebhookMessages;
  logs: WebhookLog[];
  direction: "incoming" | "outgoing";
  when: (value: string) => string;
  loading: boolean;
  onRefresh: () => void;
  facts?: { value: string }[];
}) => {
  const errors = () => props.logs.filter((log) => log.error || (log.responseStatus ?? 0) >= 400).length;
  const newest = () => props.logs[0];
  // what matters now: when the last request came in, or how many answers failed; the counts are quiet facts
  const lead = () => {
    const last = newest();
    if (!last) return props.direction === "incoming" ? props.t.nothingArrived : props.t.nothingSent;
    if (props.direction === "outgoing") return errors() > 0 ? props.t.answersFailed({ count: errors() }) : props.t.answersOk;
    return props.t.lastArrived({ time: props.when(last.createdAt) });
  };
  return (
    <StatusRow
      lead={lead()}
      loading={props.loading}
      facts={[
        { value: props.t.requestCount({ count: props.logs.length }) },
        ...(props.direction === "outgoing" && newest() ? [{ value: props.t.lastRequest({ time: props.when(newest()!.createdAt) }) }] : []),
        ...(props.facts ?? []),
      ]}
      filters={
        <Button variant="ghost" icon="refresh" onClick={props.onRefresh}>
          {props.t.refresh}
        </Button>
      }
    />
  );
};

function Sent(props: { data: WebhookTesterData }) {
  const { t, when, request, setRequest, show, toast } = useTester(props.data);
  const query = createMemo(() => sentQuery(t()));
  const [state, setState] = createSignal<ListQueryStateOf<ReturnType<typeof sentQuery>>>(query().parse(props.data.address).state);
  const source = (): WebhookQuerySource => ({
    mode: "send",
    endpointId: null,
    method: state().filters.method ?? null,
    query: state().search ?? "",
    requestId: null,
  });
  const queries = createWebhookQueries(
    source,
    props.data.failed ? undefined : { source: source(), endpoints: props.data.endpoints, logs: props.data.logs },
  );
  const logs = () => queries.logs.data() ?? [];
  const failed = () => (props.data.failed && !queries.logs.data()) || Boolean(queries.logs.error());
  const href = (id: string | null) => addressOf("send", query().serialize(state()), id);
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (!next) return;
    history.pushState(history.state, "", addressOf("send", query().serialize(next), null));
    setRequest(null);
    setState(next);
  };

  const [target, setTarget] = createSignal("");
  const [method, setMethod] = createSignal<Method>("POST");
  const [headers, setHeaders] = createSignal('{\n  "content-type": "application/json"\n}');
  const [body, setBody] = createSignal('{\n  "hello": "world"\n}');
  const [headersError, setHeadersError] = createSignal<string>();
  const [targetError, setTargetError] = createSignal<string>();
  const [sendError, setSendError] = createSignal<string>();
  // the form keeps what was typed between two sends, so a request is easy to send again with a change
  const [composing, setComposing] = createSignal(false);
  const send = mutation.create<WebhookLog, { url: string; method: Method; headers: Record<string, string>; body: string }>({
    mutation: async (intent, { abortSignal }) => {
      const response = await apiClient.webhooks.send.$post({ json: intent }, { init: { signal: abortSignal } });
      await assertOk(response);
      const log: unknown = await response.json();
      if (!isWebhookLog(log)) throw new Error(t().unexpectedResponse);
      return log;
    },
  });
  onCleanup(() => send.abort());
  const parseHeaders = (): Record<string, string> | undefined => {
    const text = headers().trim();
    if (!text) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    } catch {
      // the field says what is wrong
    }
    setHeadersError(t().headersMustBeJsonObject);
    return undefined;
  };
  const submit = async () => {
    if (send.loading()) return;
    setSendError(undefined);
    if (!target().trim()) return setTargetError(t().enterTarget);
    const parsed = parseHeaders();
    if (!parsed) return;
    const startedAt = location.href;
    const outcome = await send.mutate({ url: target().trim(), method: method(), headers: parsed, body: method() === "GET" ? "" : body() });
    // the reason (a blocked or unreachable target) stands in the dialog, where the request can be changed
    if (outcome === "error") return setSendError(send.error()?.message || t().requestFailed);
    if (outcome !== "success") return;
    const log = send.data()!;
    setComposing(false);
    toast(t().requestSent, { status: "ok" });
    try {
      await queries.logs.invalidate();
    } catch {
      return toast(t().listNotRefreshed, { status: "bad", retry: () => void queries.logs.refresh().catch(() => undefined) });
    }
    // the answer opens beside the list, unless the person went elsewhere while it was sent
    if (location.href !== startedAt) return;
    history.pushState(history.state, "", href(log.id));
    setRequest(log.id);
  };
  const openLog = () => {
    const id = request();
    return id ? logs().find((log) => log.id === id) : undefined;
  };

  return (
    <ToolsScreen
      tool="webhooks"
      views={views(t(), "send")}
      detail={request() ? DETAIL_WIDTH : undefined}
      primary={{ label: t().sendRequestTitle, icon: "send", onClick: () => setComposing(true) }}
      end={
        <>
          <SearchInput t={t()} value={state().search ?? ""} onSearch={search} />
          <Button variant="primary" icon="send" onClick={() => setComposing(true)}>
            {t().sendRequestTitle}
          </Button>
        </>
      }
    >
      <Pane.Split>
        <Pane
          label={t().requests}
          scrollKey="tools-webhooks-sent"
          status={
            <>
              <FilterBar
                query={query()}
                state={state()}
                onChange={setState}
                icons={{ method: "code" }}
                results={t().requestCount({ count: logs().length })}
              />
              <RequestStatus
                t={t()}
                logs={logs()}
                direction="outgoing"
                when={when()}
                loading={queries.logs.loading() || queries.logs.refreshing()}
                onRefresh={() => void queries.logs.refresh().catch(() => undefined)}
              />
            </>
          }
        >
          <Show
            when={!failed()}
            fallback={<Failed text={t().loadFailed} onRetry={() => void queries.logs.refresh().catch(() => undefined)} />}
          >
            <RequestTable
              label={t().requests}
              rows={logs()}
              current={request()}
              t={t()}
              when={when()}
              href={href}
              onOpen={(id) => show(id)}
              empty={
                state().search || state().filters.method
                  ? {
                      icon: "filter-off",
                      text: t().noMatches,
                      action: { label: t().resetFilters, icon: "filter-off", href: `${BASE}?mode=send` },
                    }
                  : { icon: "send", text: t().emptyOutgoing }
              }
            />
          </Show>
          <Band>
            <Text type="meta" muted>
              {t().dataNotice}
            </Text>
          </Band>
        </Pane>
        <Show when={request()}>
          <RequestPane
            log={openLog()}
            endpointName={undefined}
            t={t()}
            when={when()}
            listLabel={t().requests}
            closeHref={href(null)}
            onClose={show(null)}
          />
        </Show>
      </Pane.Split>
      <Dialog
        title={t().sendRequestTitle}
        open={composing()}
        onOpenChange={setComposing}
        foot={
          <>
            <Button onClick={() => setComposing(false)}>{t().cancel}</Button>
            <Button variant="primary" icon="send" busy={send.loading()} onClick={() => void submit()}>
              {t().send}
            </Button>
          </>
        }
      >
        <Text>{t().sendRequestSubtitle}</Text>
        <Show when={sendError()}>
          {(reason) => (
            <Notice tone="bad" title={t().requestFailed}>
              {reason()}
            </Notice>
          )}
        </Show>
        <Field.Row>
          <Field label={t().methodLabel}>
            <Select
              options={[...METHODS]}
              value={method()}
              onChange={(value) => setMethod(METHODS.find((item) => item === value) ?? "POST")}
            />
          </Field>
          <Field label={t().targetUrlLabel} error={targetError()} required>
            <Input
              type="url"
              placeholder="https://example.com/webhook"
              value={target()}
              autocomplete="url"
              spellcheck={false}
              onInput={(value) => {
                setTarget(value);
                setTargetError(undefined);
              }}
            />
          </Field>
        </Field.Row>
        <Field label={t().headersLabel} hint={t().headersHint} error={headersError()}>
          <Input
            multiline
            spellcheck={false}
            value={headers()}
            onInput={(value) => {
              setHeaders(value);
              setHeadersError(undefined);
            }}
          />
        </Field>
        <Field label={t().bodyLabel} hint={method() === "GET" ? t().bodyHint : undefined}>
          <Input multiline spellcheck={false} value={body()} onInput={setBody} disabled={method() === "GET"} />
        </Field>
      </Dialog>
    </ToolsScreen>
  );
}

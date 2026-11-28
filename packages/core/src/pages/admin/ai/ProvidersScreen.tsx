import type { AiModel, AiModelSlot, AiModelVariant, AiProvider } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import {
  Bar,
  Button,
  Cells,
  Chip,
  type Column,
  Empty,
  Facts,
  Failed,
  Icon,
  Input,
  type NavProps,
  Pane,
  Path,
  Section,
  StatusRow,
  Table,
  Text,
  useLocale,
} from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { CappedNote, ROW_CAP } from "../_area/capped";
import StateWord from "../_area/StateWord";
import { AI_AREA_PATH, aiAreaHref } from "./area";
import ConnectionDetail from "./ConnectionDetail";
import type { AiProvidersData } from "./catalog-data";
import { type AiDeleteTarget, DeleteDialog } from "./delete";
import { aiAreaLink, aiSectionLabel } from "./frame";
import ModelDetail, { aiMoney } from "./ModelDetail";
import { aiAreaMessages } from "./messages";
import {
  type AiAreaMessages,
  type AiProviderState,
  aiModelSlots,
  aiProviderState,
  aiProviderStateLabel,
  aiProviderTypeLabel,
  aiSlotLabel,
  formatAiTime,
} from "./presentation";
import { AddModelsDialog, AddProviderDialog } from "./provider-dialogs";
import { AiProviderNotice } from "./provider-notice";
import type { AiProviderFacts } from "./provider-view";
import { VariantDialog } from "./variants";

type ProviderRow = AiProvidersData["overview"]["providers"][number];

/** A good state is a neutral dot and its word; a problem stands in its colour (identity B, rule 7). */
export const ProviderState = (props: { t: AiAreaMessages; state: AiProviderState }) => (
  <Show
    when={props.state === "badkey" || props.state === "unreachable" || props.state === "nokey"}
    fallback={<StateWord muted={props.state === "off"}>{aiProviderStateLabel(props.t, props.state)}</StateWord>}
  >
    <Text tone={props.state === "nokey" ? "warn" : "bad"} weight="medium">
      <Icon name="point-filled" /> {aiProviderStateLabel(props.t, props.state)}
    </Text>
  </Show>
);

/**
 * Providers on v2: the providers as a dense table with their state; the open provider beside it with its key facts,
 * its models and its connection; one level deeper the provider's models beside the open model or the connection form.
 * Everything open lives in the address (`p`, `m`, `pane=conn`); `o` opens the add dialogs once.
 */
export default function ProvidersScreen(props: { nav: NavProps; data: AiProvidersData }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const data = () => props.data;
  const providers = () => data().overview.providers;
  const index = () => ({ models: data().models, variants: data().variants, assignments: data().overview.assignments });
  const summary = () => (data().open.p ? providers().find((entry) => entry.id === data().open.p) : undefined);
  const provider = () => data().provider;
  const deep = () => Boolean(data().open.m || data().open.connection);
  const [adding, setAdding] = createSignal<"provider" | "models" | null>(null);
  const [variant, setVariant] = createSignal<{ variant?: AiModelVariant } | null>(null);
  const [removing, setRemoving] = createSignal<AiDeleteTarget | null>(null);
  // a dialog the address opens (right after a provider was saved, or from another section) opens once
  onMount(() => {
    const dialog = data().open.dialog;
    if (!dialog) return;
    setAdding(dialog);
    const params = new URLSearchParams(window.location.search);
    params.delete("o");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
  });

  /** A provider's model counts and the classes and tools its models fill, counted on the server. */
  const factsOf = (id: string): AiProviderFacts => data().catalog.providers[id] ?? { models: 0, enabled: 0, slots: [] };
  const slotsOf = (model: AiModel) => aiModelSlots(index(), model.id);
  /** The search in the open provider's models (`mq`); the server answers it with the rows and how many match. */
  const modelQuery = () => data().open.mq;
  const rows = () => {
    const shown = new Set(data().list.rows);
    return data().models.filter((model) => shown.has(model.id));
  };
  const providersHref = aiAreaHref({ sec: "providers" });
  /** The open provider keeps its model search; another provider opens with all of its models. */
  const providerHref = (id: string) => aiAreaHref({ sec: "providers", p: id, mq: id === data().open.p ? modelQuery() : undefined });
  const searchModels = (text: string) => {
    const params = new URLSearchParams(window.location.search);
    if (text.trim()) params.set("mq", text.trim());
    else params.delete("mq");
    navigateTo(`${window.location.pathname}?${params}`);
  };
  const assignments = () =>
    Object.fromEntries(Object.entries(data().overview.assignments).map(([slot, entry]) => [slot, entry.variantId])) as Partial<
      Record<AiModelSlot, string | null>
    >;
  const connected = () => providers().filter((entry) => aiProviderState(entry) === "ok").length;
  /** The exceptions by state, each with who: "1 Schlüssel fehlt · OpenAI" (identity B, rule 1). */
  const problems = () =>
    (["unreachable", "badkey", "nokey"] as const)
      .map((state) => ({
        state,
        names: providers()
          .filter((entry) => aiProviderState(entry) === state)
          .map((entry) => entry.label),
      }))
      .filter((problem) => problem.names.length > 0);
  const price = (model: AiModel) =>
    model.pricing
      ? `${aiMoney(locale(), model.pricing.inputPerMillion, "EUR", 2)} / ${aiMoney(locale(), model.pricing.outputPerMillion, "EUR", 2)}`
      : "";
  const kindLabel = (model: AiModel) =>
    model.kind === "transcription"
      ? t().kindAudio
      : model.kind === "live-transcription"
        ? t().kindLiveAudio
        : model.kind === "decision"
          ? t().kindDecision
          : t().kindChat;
  const providerUse = (id: string) =>
    factsOf(id)
      .slots.map((slot) => aiSlotLabel(t(), slot))
      .join(", ");
  const classes = (model: AiModel) =>
    slotsOf(model)
      .map((slot) => aiSlotLabel(t(), slot))
      .join(", ");

  const pathItems = () => [
    aiAreaLink(locale()),
    { label: aiSectionLabel(locale(), "providers"), href: providersHref },
    ...(summary() ? [{ label: summary()!.label, href: providerHref(summary()!.id) }] : []),
    ...(data().model ? [{ label: data().model!.label }] : data().open.connection ? [{ label: t().connection }] : []),
  ];

  /** The providers as a table: sign and name, state, models, type, the data boundary only where it limits. */
  const providerTable = () => (
    <Table
      label={aiSectionLabel(locale(), "providers")}
      rows={providers()}
      rowKey={(entry) => entry.id}
      current={summary()?.id}
      open={(entry) => ({ href: providerHref(entry.id) })}
      empty={{
        icon: "plug-connected",
        text: `${t().emptyTitle}. ${t().emptySteps}`,
        action: { label: t().addProvider, icon: "plus", onClick: () => setAdding("provider") },
      }}
      phone={(entry) => ({
        // slot for #4208/#4223 (DP): the provider's mark leads the phone row
        lines: [
          entry.label,
          <>
            <ProviderState t={t()} state={aiProviderState(entry)} />
            {` · ${t().nModels({ p: entry.modelCount })}`}
          </>,
        ],
      })}
      columns={[
        {
          title: t().colProvider,
          width: { min: 160, default: 220 },
          // slot for #4208/#4223 (DP): Column mark, the provider's kind (server-2 for ollama and vllm, plug-connected for openai-compatible, else cloud) in aiProviderMark(provider).color
          cell: (entry) => entry.label,
        },
        {
          title: t().colState,
          width: { min: 120, default: 150 },
          cell: (entry) => <ProviderState t={t()} state={aiProviderState(entry)} />,
        },
        { title: t().colModels, width: { min: 72, default: 88 }, align: "end", cell: (entry) => String(entry.modelCount) },
        // beside an open provider only the columns that fit stay; its detail says the rest
        ...(summary()
          ? []
          : ([
              // which classes and tools this provider's models fill: what breaks when it breaks
              { title: t().colUse, width: { min: 160, default: 260 }, drop: true, cell: (entry) => providerUse(entry.id) },
              {
                title: t().dataBoundary,
                width: { min: 120, default: 140 },
                drop: true,
                cell: (entry) => (entry.dataBoundary === "restricted" ? <Chip icon="shield-off">{t().boundaryRestrictedShort}</Chip> : ""),
              },
              { title: t().type, drop: true, cell: (entry) => aiProviderTypeLabel(t(), entry.type) },
            ] satisfies Column<ProviderRow>[])),
      ]}
    />
  );

  /**
   * The search in a provider's models, where its list is longer than one capped table or a search is set. Enter sends
   * `mq` also without JavaScript (a GET form, with the open model kept); Escape in a filled field shows all again.
   */
  const searchable = (entry: ProviderRow) => factsOf(entry.id).models > ROW_CAP || Boolean(modelQuery());
  const searchParams = (entry: ProviderRow) => {
    const params: [string, string][] = [
      ["sec", "providers"],
      ["p", entry.id],
    ];
    const open = data().open.m;
    if (open) params.push(["m", open]);
    return params;
  };
  const modelSearch = (entry: ProviderRow) => (
    <Show when={searchable(entry)}>
      <Input
        type="search"
        icon="search"
        name="mq"
        label={t().searchProviderModels}
        placeholder={t().amSearch}
        value={modelQuery()}
        send={{ action: AI_AREA_PATH, params: searchParams(entry), onSearch: searchModels }}
        onKeyDown={(event) => {
          if (event.isComposing) return;
          const input = event.currentTarget as HTMLInputElement;
          if (event.key === "Escape" && input.value) {
            input.value = "";
            searchModels("");
          }
        }}
      />
    </Show>
  );

  /**
   * The models of one provider: in its detail, and as the list beside an open model. An open model's detail is its own
   * address (`m`) and reads on the server, so it opens also when its row is not among the rows shown.
   */
  // k2b-ui gap: virtual Table (MW, #4211); until it lands the table shows the first ROW_CAP matches and a line says how to reach the rest
  const modelTable = (entry: ProviderRow, narrow: boolean) => (
    <Table
      label={t().nModels({ p: factsOf(entry.id).models })}
      rows={rows()}
      rowKey={(model) => model.id}
      current={data().open.m ?? undefined}
      open={(model) => ({ href: aiAreaHref({ sec: "providers", p: entry.id, m: model.id, mq: modelQuery() }) })}
      empty={
        modelQuery()
          ? {
              icon: "filter-off",
              text: t().noModelsMatch({ p: modelQuery() }),
              action: { label: t().showAllModels, href: aiAreaHref({ sec: "providers", p: entry.id, m: data().open.m ?? undefined }) },
            }
          : {
              icon: "cube",
              text: `${t().noModelsYet}. ${t().noModelsYetSub}`,
              action: { label: t().addModels, icon: "plus", onClick: () => setAdding("models") },
            }
      }
      phone={(model) => ({
        // slot for #4208/#4223 (DP): the model's mark leads the phone row
        lines: [model.label, [kindLabel(model), classes(model), model.enabled ? "" : t().disabled].filter(Boolean).join(" · ")],
      })}
      columns={[
        {
          title: t().modelLabel,
          width: narrow ? { min: 180, default: 220 } : { min: 140, default: 170 },
          // slot for #4208/#4223 (DP): Column mark, the model's uploaded picture, else its kind (microphone for transcription, route for decision, message-2 for chat) in its provider's colour
          cell: (model) => model.label,
        },
        ...(narrow
          ? []
          : [
              { title: t().kind, width: { min: 64, default: 80 }, drop: true, cell: kindLabel },
              { title: t().colPrice, width: { min: 110, default: 130 }, drop: true, cell: price },
            ]),
        {
          title: t().colUse,
          cell: (model) => (model.enabled ? classes(model) : <StateWord muted>{t().disabled}</StateWord>),
        },
      ]}
    />
  );

  const ProviderDetail = (detail: { entry: ProviderRow; full: AiProvider }) => {
    const state = () => aiProviderState(detail.entry);
    const active = () => factsOf(detail.entry.id).enabled;
    return (
      <Pane
        detail
        label={detail.entry.label}
        back={{ label: aiSectionLabel(locale(), "providers"), href: providersHref }}
        scrollKey="admin-ai-provider"
        head={
          <Bar
            start={
              // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the provider's mark; the name stands in
              <Text type="body">{detail.entry.label}</Text>
            }
            end={
              <>
                <Button icon="pencil" href={aiAreaHref({ sec: "providers", p: detail.entry.id, pane: "conn" })}>
                  {t().editConn}
                </Button>
                <Button variant="ghost" icon="x" label={t().close} href={providersHref} />
              </>
            }
          />
        }
      >
        <AiProviderNotice
          providerId={detail.entry.id}
          providerLabel={detail.entry.label}
          state={state()}
          status={detail.entry.status}
          statusCode={detail.entry.statusCode}
          statusMessage={detail.entry.statusMessage}
          checkedAt={detail.entry.statusCheckedAt ?? null}
        />
        <Cells>
          <Cells.Cell
            icon="plug-connected"
            label={t().colState}
            value={<ProviderState t={t()} state={state()} />}
            meta={detail.entry.statusCheckedAt ? t().checkedAt({ p: formatAiTime(locale(), detail.entry.statusCheckedAt) }) : undefined}
          />
          <Cells.Cell icon="cube" label={t().colModels} value={String(detail.entry.modelCount)} meta={t().nActive({ p: active() })} />
          <Cells.Cell
            icon={detail.entry.dataBoundary === "restricted" ? "shield-off" : detail.entry.dataBoundary === "private" ? "lock" : "world"}
            label={t().dataBoundary}
            value={
              detail.entry.dataBoundary === "restricted"
                ? t().boundaryRestrictedShort
                : detail.entry.dataBoundary === "private"
                  ? t().private
                  : t().hosted
            }
            meta={aiProviderTypeLabel(t(), detail.entry.type)}
          />
        </Cells>
        <Section
          icon="cube"
          title={t().variantsModels}
          count={factsOf(detail.entry.id).models}
          actions={[{ label: t().addModels, icon: "plus", onClick: () => setAdding("models") }]}
        >
          {modelSearch(detail.entry)}
          {modelTable(detail.entry, false)}
          <CappedNote total={data().list.matching} />
        </Section>
        <Section icon="plug-connected" title={t().connection}>
          <Facts
            items={[
              { label: t().type, value: aiProviderTypeLabel(t(), detail.full.type) },
              detail.full.baseUrl
                ? { label: t().baseUrl, value: detail.full.baseUrl, mono: true, copy: detail.full.baseUrl }
                : { label: t().baseUrl, value: t().providerDefaultUrl },
              { label: t().apiKey, value: detail.full.credentialSet ? t().keyStoredPlain : t().keyNone },
              {
                label: t().extraHeaders,
                value: detail.full.requestHeaderNames.length ? detail.full.requestHeaderNames.join(", ") : t().none,
                mono: detail.full.requestHeaderNames.length > 0,
              },
              { label: t().providerId, value: detail.full.id, mono: true, copy: detail.full.id },
            ]}
          />
        </Section>
      </Pane>
    );
  };

  const failedDetail = () => (
    <Pane detail label={t().loadFailTitle} back={{ label: aiSectionLabel(locale(), "providers"), href: providersHref }}>
      <Failed text={`${t().loadFailTitle}. ${t().loadFailSub}`} onRetry={() => window.location.reload()} />
    </Pane>
  );
  const goneDetail = (text: string, back: { label: string; href: string }) => (
    <Pane detail label={text} back={back}>
      <Empty icon="plug-off" text={text} action={{ label: back.label, href: back.href }} />
    </Pane>
  );

  const detail = () => {
    if (!data().open.p) return undefined;
    if (data().detailFailed) return failedDetail();
    const entry = summary();
    const full = provider();
    const back = { label: aiSectionLabel(locale(), "providers"), href: providersHref };
    if (!entry || !full) return goneDetail(t().providerMissing, back);
    const toProvider = { label: entry.label, href: providerHref(entry.id) };
    if (data().open.connection)
      return <ConnectionDetail provider={full} back={toProvider} onDelete={() => setRemoving({ kind: "provider", provider: full })} />;
    if (data().open.m) {
      const model = data().model;
      if (!model) return goneDetail(t().modelMissing, toProvider);
      return (
        <ModelDetail
          provider={full}
          model={model}
          usage={data().usage}
          slots={aiModelSlots(index(), model.id)}
          assignments={assignments()}
          accountingUnit={data().accountingUnit}
          back={toProvider}
          onVariant={(open) => setVariant({ variant: open })}
          onDelete={() => setRemoving({ kind: "model", model, provider: full })}
        />
      );
    }
    return <ProviderDetail entry={entry} full={full} />;
  };

  const addModelsFor = () => summary();
  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while something is open: no empty half (identity rule 5)
      detail={data().open.p ? 560 : undefined}
      head={
        <Bar
          start={<Path label={aiSectionLabel(locale(), "providers")} items={pathItems()} />}
          end={
            deep() ? (
              <Button icon="plus" onClick={() => setAdding("models")}>
                {t().addModels}
              </Button>
            ) : (
              <Button variant="primary" icon="plus" onClick={() => setAdding("provider")}>
                {t().addProvider}
              </Button>
            )
          }
        />
      }
      primary={data().open.p ? undefined : { label: t().addProvider, icon: "plus", onClick: () => setAdding("provider") }}
    >
      <Pane.Split>
        <Show
          when={deep() && summary()}
          fallback={
            <Pane
              label={aiSectionLabel(locale(), "providers")}
              width={data().open.p ? { min: 420, default: 560 } : undefined}
              scrollKey="admin-ai-providers"
              status={
                providers().length ? (
                  // k2b-ui gap: Hero figure (#4360); the statement stands in the status row until the hero band exists
                  <StatusRow
                    lead={t().providersLead({ ok: connected(), total: providers().length })}
                    // the exceptions name who: "1 gestört · Cortecs" (identity B, rule 1)
                    facts={[
                      { value: data().catalog.total, after: t().modelsWord },
                      ...problems().map((problem) => ({
                        value: problem.names.length,
                        after: `${aiProviderStateLabel(t(), problem.state)} · ${problem.names.join(", ")}`,
                      })),
                    ]}
                  />
                ) : undefined
              }
            >
              {providerTable()}
            </Pane>
          }
        >
          {(entry) => (
            <Pane
              label={t().nModels({ p: factsOf(entry().id).models })}
              width={{ min: 300, default: 380 }}
              scrollKey="admin-ai-provider-models"
              status={
                <StatusRow lead={`${entry().label} · ${t().nModels({ p: factsOf(entry().id).models })}`} filters={modelSearch(entry())} />
              }
            >
              {modelTable(entry(), true)}
              <CappedNote total={data().list.matching} />
            </Pane>
          )}
        </Show>
        {detail()}
      </Pane.Split>
      <AddProviderDialog open={adding() === "provider"} onClose={() => setAdding(null)} />
      <Show when={addModelsFor()}>
        {(entry) => (
          <AddModelsDialog
            open={adding() === "models"}
            onClose={() => setAdding(null)}
            providerId={entry().id}
            providerType={entry().type}
            chatOnly={entry().dataBoundary === "restricted"}
            providerLabel={entry().label}
            existing={data().list.existing}
          />
        )}
      </Show>
      <Show when={provider() && data().model ? { full: provider()!, model: data().model! } : undefined}>
        {(open) => (
          <Show when={variant()} keyed>
            {(current) => (
              <VariantDialog
                open
                onClose={() => setVariant(null)}
                model={open().model}
                provider={open().full}
                variant={current.variant}
                onDelete={(entry) => {
                  setVariant(null);
                  setRemoving({ kind: "variant", variant: entry, model: open().model, provider: open().full });
                }}
              />
            )}
          </Show>
        )}
      </Show>
      <DeleteDialog target={removing()} onClose={() => setRemoving(null)} />
    </AdminWorkspace>
  );
}

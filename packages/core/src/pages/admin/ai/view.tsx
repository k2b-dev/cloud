import type { AiAdminOverview } from "@k2b/cloud/ai/admin";
import { AiModelIcon, aiModelDisplayIcon } from "@k2b/cloud/ai/ui";
import {
  AI_MODEL_CLASSES,
  type AiModel,
  type AiModelSlot,
  type AiModelUsage,
  type AiModelVariant,
  type AiProvider,
} from "@k2b/cloud/shared";
import { AppWorkspace, NoticeCard, Placeholder, StatusBadge } from "@k2b/ui";
import type { JSX } from "solid-js";
import AiAreaActions from "./AiAreaActions.island";
import AiClassDetail from "./AiClassDetail.island";
import AiConnectionDetail from "./AiConnectionDetail.island";
import AiDetailActions from "./AiDetailActions.island";
import AiModelDetail from "./AiModelDetail.island";
import AiProviderNotice from "./AiProviderNotice.island";
import { type AiAreaQuery, aiAreaHref, aiAreaLevel, isWideSection } from "./area";
import {
  type AiAreaMessages,
  type AiCatalogIndex,
  aiClassSubtitle,
  aiModelSlots,
  aiProviderState,
  aiProviderStateLabel,
  aiProviderStateTone,
  aiProviderTypeLabel,
  aiSlotLabel,
  aiVariantName,
  findAiVariant,
  isAiModelClass,
} from "./presentation";

type Overview = AiAdminOverview;
type ProviderRow = Overview["providers"][number];

const sectionIcon = {
  classes: "ti ti-stairs-up",
  providers: "ti ti-plug-connected",
  general: "ti ti-adjustments",
  budgets: "ti ti-gauge",
  jobs: "ti ti-activity",
  tools: "ti ti-plug",
  skills: "ti ti-wand",
  projects: "ti ti-folders",
  usage: "ti ti-chart-histogram",
} as const;

const ProviderMark = (props: { provider: Pick<ProviderRow, "id" | "label"> }) => (
  <AiModelIcon icon={aiModelDisplayIcon({ kind: "provider" }, props.provider)} size="sm" />
);

const providerLine = (t: AiAreaMessages, provider: ProviderRow) => {
  const state = aiProviderState(provider);
  return `${aiProviderStateLabel(t, state)} · ${t.nModels({ p: provider.modelCount })}`;
};

/** Column 1: the area. Model classes first, then providers, settings, content and insight. */
function AreaColumn(props: {
  t: AiAreaMessages;
  query: AiAreaQuery;
  overview: Overview;
  studioLinks: { href: string; label: string; icon: string; app: string }[];
}) {
  const t = props.t;
  const assigned = AI_MODEL_CLASSES.filter((modelClass) => props.overview.assignments[modelClass]?.variantId).length;
  const item = (section: Exclude<AiAreaQuery["sec"], undefined | "providers">, label: string) => (
    <AppWorkspace.SidebarItem href={aiAreaHref({ sec: section })} active={props.query.sec === section} icon={sectionIcon[section]}>
      {label}
    </AppWorkspace.SidebarItem>
  );
  return (
    <>
      <AppWorkspace.SidebarSection>
        <AppWorkspace.SidebarItem
          href={aiAreaHref({ sec: "classes" })}
          active={props.query.sec === "classes"}
          icon={sectionIcon.classes}
          description={t.recsSub({ p: assigned })}
        >
          {t.recs}
        </AppWorkspace.SidebarItem>
      </AppWorkspace.SidebarSection>
      <AppWorkspace.SidebarSection title={t.g_models}>
        {props.overview.providers.length === 0 ? (
          <p class="px-3 py-1 text-sm text-(--k2b-text-muted)">{t.emptyNav}</p>
        ) : (
          props.overview.providers.map((provider) => {
            const state = aiProviderState(provider);
            return (
              <AppWorkspace.SidebarItem
                href={aiAreaHref({ sec: "providers", p: provider.id })}
                active={props.query.sec === "providers" && props.query.p === provider.id}
                description={
                  <span class="inline-flex items-center gap-1.5">
                    <StatusBadge tone={aiProviderStateTone(state)} variant="dot" label="" class="shrink-0" />
                    {providerLine(t, provider)}
                  </span>
                }
              >
                <AppWorkspace.SidebarItemIcon>
                  <ProviderMark provider={provider} />
                </AppWorkspace.SidebarItemIcon>
                <AppWorkspace.SidebarItemLabel>{provider.label}</AppWorkspace.SidebarItemLabel>
              </AppWorkspace.SidebarItem>
            );
          })
        )}
        <AiAreaActions kind="add-provider" variant="row" />
      </AppWorkspace.SidebarSection>
      <AppWorkspace.SidebarSection title={t.g_settings}>
        {item("general", t.general)}
        {item("budgets", t.budgets)}
        {item("jobs", t.jobs)}
        {item("tools", t.tools)}
      </AppWorkspace.SidebarSection>
      <AppWorkspace.SidebarSection title={t.g_content}>
        {item("skills", t.skills)}
        {item("projects", t.projects)}
        {props.studioLinks.map((link) => (
          <AppWorkspace.SidebarItem href={link.href} icon={`ti ${link.icon}`} description={link.app} navigation="document">
            {link.label}
          </AppWorkspace.SidebarItem>
        ))}
      </AppWorkspace.SidebarSection>
      <AppWorkspace.SidebarSection title={t.g_insight}>{item("usage", t.usage)}</AppWorkspace.SidebarSection>
    </>
  );
}

const ClassChips = (props: { t: AiAreaMessages; slots: AiModelSlot[]; enabled: boolean }) => (
  <span class="flex flex-wrap justify-end gap-1">
    {!props.enabled ? <StatusBadge tone="neutral" variant="chip" icon={null} label={props.t.disabled} /> : null}
    {props.slots.map((slot) => (
      <StatusBadge tone={slot === "balanced" ? "info" : "neutral"} variant="chip" icon={null} label={aiSlotLabel(props.t, slot)} />
    ))}
  </span>
);

/** Column 2 for a provider: its connection, then its models. */
function ProviderColumn(props: { t: AiAreaMessages; locale: string; query: AiAreaQuery; provider: ProviderRow; index: AiCatalogIndex }) {
  const t = props.t;
  const state = aiProviderState(props.provider);
  const models = props.index.models.filter((model) => model.providerId === props.provider.id);
  const variantsOf = (model: AiModel) => props.index.variants.filter((variant) => variant.modelId === model.id);
  return (
    <>
      <AiProviderNotice
        providerId={props.provider.id}
        providerLabel={props.provider.label}
        state={state}
        statusMessage={props.provider.statusMessage}
        checkedAt={props.provider.statusCheckedAt ?? null}
      />
      <AppWorkspace.SidebarSection>
        <AppWorkspace.SidebarItem
          href={aiAreaHref({ sec: "providers", p: props.provider.id, pane: "conn" })}
          active={props.query.pane === "conn"}
          icon="ti ti-plug-connected"
          description={
            <span class="inline-flex items-center gap-1.5">
              <StatusBadge tone={aiProviderStateTone(state)} variant="dot" label="" class="shrink-0" />
              {aiProviderStateLabel(t, state)}
            </span>
          }
        >
          {t.connection}
        </AppWorkspace.SidebarItem>
      </AppWorkspace.SidebarSection>
      {models.length === 0 ? (
        <Placeholder
          icon="ti ti-cube"
          title={t.noModelsYet}
          description={t.noModelsYetSub}
          action={<AiAreaActions kind="add-models" providerId={props.provider.id} providerLabel={props.provider.label} existing={[]} />}
        />
      ) : (
        <AppWorkspace.SidebarSection title={t.nModels({ p: models.length })}>
          {models.map((model) => (
            <AppWorkspace.SidebarItem
              href={aiAreaHref({ sec: "providers", p: props.provider.id, m: model.id })}
              active={props.query.m === model.id}
              description={variantsOf(model)
                .map((variant) => variant.label)
                .join(" · ")}
              meta={<ClassChips t={t} slots={aiModelSlots(props.index, model.id)} enabled={model.enabled} />}
            >
              <AppWorkspace.SidebarItemIcon>
                <AiModelIcon icon={aiModelDisplayIcon(model.icon, props.provider)} size="sm" />
              </AppWorkspace.SidebarItemIcon>
              <AppWorkspace.SidebarItemLabel>{model.label}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
          ))}
        </AppWorkspace.SidebarSection>
      )}
    </>
  );
}

/** Column 2 for model classes: four classes, then the two tools. */
function ClassesColumn(props: { t: AiAreaMessages; query: AiAreaQuery; overview: Overview; index: AiCatalogIndex }) {
  const t = props.t;
  const providerOf = (model: AiModel) =>
    props.overview.providers.find((provider) => provider.id === model.providerId) ?? { id: model.providerId, label: "" };
  const nothingAssigned = AI_MODEL_CLASSES.every((modelClass) => !props.overview.assignments[modelClass]?.variantId);
  const affected = (variantId: string | null | undefined) => {
    const found = findAiVariant(props.index, variantId);
    const provider = found ? props.overview.providers.find((candidate) => candidate.id === found.model.providerId) : undefined;
    const state = provider ? aiProviderState(provider) : "ok";
    return state === "unreachable" || state === "badkey" || state === "off" ? aiProviderStateLabel(t, state) : null;
  };
  const row = (slot: AiModelSlot, subtitle?: string) => {
    const variantId = props.overview.assignments[slot]?.variantId;
    const found = findAiVariant(props.index, variantId);
    const effective = slot in props.overview.effective ? props.overview.effective[slot as keyof Overview["effective"]] : undefined;
    const fallback = !found && effective?.class ? t.clsUses({ p: aiSlotLabel(t, effective.class) }) : !found ? t.clsUnassigned : undefined;
    const issue = affected(variantId);
    return (
      <AppWorkspace.SidebarItem
        href={aiAreaHref({ sec: "classes", slot })}
        active={props.query.slot === slot}
        description={
          <span class="grid">
            {subtitle ? <span>{subtitle}</span> : null}
            <span class={found ? "text-(--k2b-text-secondary)" : "text-(--k2b-warning-text)"}>
              {found ? aiVariantName(found.model, found.variant) : fallback}
              {issue ? <span class="text-(--k2b-danger-text)"> · {issue}</span> : null}
            </span>
          </span>
        }
        meta={slot === "balanced" ? <StatusBadge tone="info" variant="chip" icon={null} label={t.rgStart} /> : undefined}
      >
        <AppWorkspace.SidebarItemIcon>
          {found ? (
            <AiModelIcon icon={aiModelDisplayIcon(found.model.icon, providerOf(found.model))} size="sm" />
          ) : (
            <span
              class="inline-grid size-7 place-items-center rounded-md border border-dashed border-(--k2b-border-strong)"
              aria-hidden="true"
            />
          )}
        </AppWorkspace.SidebarItemIcon>
        <AppWorkspace.SidebarItemLabel>{aiSlotLabel(t, slot)}</AppWorkspace.SidebarItemLabel>
      </AppWorkspace.SidebarItem>
    );
  };
  return (
    <>
      {nothingAssigned ? (
        <div class="px-3 pb-2">
          <NoticeCard
            tone={props.index.models.length ? "danger" : "info"}
            title={props.index.models.length ? t.clsNoneAtAll : t.clsEmptyNote}
          />
        </div>
      ) : null}
      <AppWorkspace.SidebarSection title={t.slots_people}>
        {AI_MODEL_CLASSES.map((modelClass) => row(modelClass, aiClassSubtitle(t, modelClass)))}
      </AppWorkspace.SidebarSection>
      <p class="px-4 pb-3 text-xs text-(--k2b-text-muted)">{t.clsRuleShort}</p>
      <AppWorkspace.SidebarSection title={t.slots_cloud}>
        {row("vision")}
        {row("audio")}
      </AppWorkspace.SidebarSection>
    </>
  );
}

export type AiAreaViewProps = {
  t: AiAreaMessages;
  locale: string;
  query: AiAreaQuery;
  overview: Overview | null;
  index: AiCatalogIndex | null;
  loadFailed: boolean;
  studioLinks: { href: string; label: string; icon: string; app: string }[];
  provider: ProviderRow | undefined;
  providerDetail: (AiProvider & { models: AiModel[] }) | null;
  model: (AiModel & { variants: AiModelVariant[] }) | null;
  usage: AiModelUsage | null;
  accountingUnit: string | null;
  assignmentDetails: AssignmentDetail[] | null;
  appNames: Record<string, string>;
  retryHref: string;
  /** Content of a wide section, which fills the second and third column. */
  wide?: JSX.Element;
};

type AssignmentDetail = {
  slot: AiModelSlot;
  variantId: string | null;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
  fallbackChain: import("@k2b/cloud/shared").AiModelClass[];
  effectiveClass: import("@k2b/cloud/shared").AiModelClass | null;
  usage: { class: string; app: string | null; task: string; calls: number }[];
};

/** The AI area: the area column, the section column and the detail column, or one wide section. */
export function AiAreaView(props: AiAreaViewProps) {
  const { t, locale, query, overview, index, loadFailed, studioLinks, provider, providerDetail, model, usage, assignmentDetails } = props;
  const section = query.sec;
  const level = aiAreaLevel(query);
  const quotaConfig = props.accountingUnit ? { unit: props.accountingUnit } : null;
  const runtime = { apps: Object.entries(props.appNames).map(([id, name]) => ({ id, name })) };
  const sectionTitle = section
    ? {
        classes: t.recs,
        providers: provider?.label ?? t.g_models,
        general: t.general,
        budgets: t.budgets,
        jobs: t.jobs,
        tools: t.tools,
        skills: t.skills,
        projects: t.projects,
        usage: t.usage,
      }[section]
    : t.aiArea;

  const failure = (
    <Placeholder
      state="error"
      icon="ti ti-alert-triangle"
      title={t.loadFailTitle}
      description={t.loadFailSub}
      action={
        <a class="k2b-button" data-variant="secondary" href={props.retryHref}>
          <i class="ti ti-refresh" aria-hidden="true" />
          {t.retry}
        </a>
      }
    />
  );

  const detail = (): JSX.Element => {
    if (!overview || !index) return failure;
    if (query.sec === "providers" && provider && query.pane === "conn" && providerDetail)
      return <AiConnectionDetail provider={providerDetail} />;
    if (query.sec === "providers" && provider && model && providerDetail)
      return (
        <AiModelDetail
          provider={providerDetail}
          model={model}
          usage={usage}
          slots={aiModelSlots(index, model.id)}
          assignments={Object.fromEntries(Object.entries(overview.assignments).map(([slot, entry]) => [slot, entry.variantId]))}
          accountingUnit={quotaConfig?.unit ?? null}
          budgetRules={usage?.budgetRules ?? []}
        />
      );
    if (query.sec === "classes" && query.slot) {
      const detail = assignmentDetails?.find((entry) => entry.slot === query.slot);
      if (!detail) return failure;
      return (
        <AiClassDetail
          slot={query.slot}
          assignment={detail}
          providers={overview.providers.map((entry) => ({ id: entry.id, label: entry.label, state: aiProviderState(entry) }))}
          models={index.models}
          variants={index.variants}
          effective={overview.effective}
          assignments={overview.assignments}
          appNames={Object.fromEntries(runtime.apps.map((app) => [app.id, app.name]))}
        />
      );
    }
    return (
      <Placeholder
        icon={query.sec === "classes" ? sectionIcon.classes : "ti ti-cube"}
        description={query.sec === "providers" ? t.chooseModelHint : t.chooseItemHint}
      />
    );
  };

  const secondColumn = (): JSX.Element => {
    if (!overview || !index) return failure;
    if (query.sec === "providers" && provider)
      return <ProviderColumn t={t} locale={locale} query={query} provider={provider} index={index} />;
    if (query.sec === "providers" && query.p) return <Placeholder state="error" icon="ti ti-plug-off" title={t.providerMissing} />;
    if (query.sec === "classes") return <ClassesColumn t={t} query={query} overview={overview} index={index} />;
    if (overview.providers.length === 0)
      return (
        <div class="grid gap-3 px-4 py-2">
          <h3 class="text-base font-semibold">{t.emptyTitle}</h3>
          <p class="text-sm text-(--k2b-text-muted)">{t.emptySub}</p>
          <ol class="list-decimal space-y-1 ps-5 text-sm">
            <li>{t.step1}</li>
            <li>{t.step2}</li>
            <li>{t.step3}</li>
          </ol>
          <div>
            <AiAreaActions kind="add-provider" variant="button" />
          </div>
        </div>
      );
    return <Placeholder icon="ti ti-sparkles" description={t.chooseItemHint} />;
  };

  const secondActions = (): JSX.Element =>
    query.sec === "providers" && provider ? (
      <AiAreaActions
        kind="add-models"
        providerId={provider.id}
        providerLabel={provider.label}
        existing={index?.models.filter((entry) => entry.providerId === provider.id).map((entry) => entry.providerModel) ?? []}
        variant="button"
      />
    ) : undefined;

  const secondDescription = (): string | undefined => {
    if (query.sec === "providers" && provider) return aiProviderTypeLabel(t, provider.type);
    if (query.sec === "classes" && overview)
      return t.recsSub({ p: AI_MODEL_CLASSES.filter((modelClass) => overview?.assignments[modelClass]?.variantId).length });
    return undefined;
  };

  const detailDescription = (): string | undefined => {
    if (model) return provider?.label;
    if (query.pane === "conn") return provider?.label;
    if (query.slot)
      return isAiModelClass(query.slot) ? aiClassSubtitle(t, query.slot) : query.slot === "vision" ? t.slotd_vision : t.slotd_audio;
    return undefined;
  };

  const detailTitle = (): string => {
    if (model) return model.label;
    if (query.pane === "conn") return t.connection;
    if (query.slot) return aiSlotLabel(t, query.slot);
    return query.sec === "classes" ? t.recs : t.g_models;
  };

  return (
    <AppWorkspace.Main level={isWideSection(section) ? (level === "area" ? "area" : "section") : level}>
      <AppWorkspace.MainPane
        id="area"
        label={t.aiArea}
        href={aiAreaHref({})}
        defaultSize={264}
        minSize={232}
        maxSize={360}
        actions={<AiAreaActions kind="add-provider" variant="icon" />}
      >
        {overview ? <AreaColumn t={t} query={query} overview={overview} studioLinks={studioLinks} /> : loadFailed ? failure : null}
      </AppWorkspace.MainPane>
      {isWideSection(section) ? (
        <AppWorkspace.MainPane id="section" label={sectionTitle}>
          {props.wide ?? failure}
        </AppWorkspace.MainPane>
      ) : (
        <>
          <AppWorkspace.MainPane
            id="section"
            label={sectionTitle}
            description={secondDescription()}
            href={section ? aiAreaHref({ sec: section, ...(query.p ? { p: query.p } : {}) }) : aiAreaHref({})}
            defaultSize={320}
            minSize={280}
            maxSize={480}
            actions={secondActions()}
          >
            {secondColumn()}
          </AppWorkspace.MainPane>
          <AppWorkspace.MainPane
            id="detail"
            label={detailTitle()}
            description={detailDescription()}
            actions={model || (query.pane === "conn" && providerDetail) ? <AiDetailActions enabled={Boolean(model)} test /> : undefined}
          >
            {detail()}
          </AppWorkspace.MainPane>
        </>
      )}
    </AppWorkspace.Main>
  );
}

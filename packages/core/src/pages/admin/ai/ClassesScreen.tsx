import { AiModelCard, type AiModelCardStop, aiModelDisplayIcon } from "@k2b/cloud/ai/ui";
import {
  AI_MODEL_CLASSES,
  AiAssignmentSchema,
  type AiModel,
  type AiModelAssignment,
  type AiModelClass,
  type AiModelSlot,
  type AiModelVariant,
  aiModelClassFallbackChain,
  aiModelSupportsSlot,
  aiProviderMark,
} from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import {
  Bar,
  Button,
  Canvas,
  Facts,
  Icon,
  Menu,
  type MenuEntry,
  type NavProps,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useLocale,
} from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { aiAreaHref } from "./area";
import type { AiClassesData } from "./catalog-data";
import { type AiAdminConflict, aiAdminApi, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaLink, aiSectionLabel } from "./frame";
import { aiAreaMessages } from "./messages";
import {
  type AiAreaMessages,
  aiClassSubtitle,
  aiProviderState,
  aiProviderStateLabel,
  aiSlotLabel,
  aiVariantName,
  formatAiTime,
  isAiModelClass,
} from "./presentation";
import { effortLabel } from "./variants";

const TOOLS: AiModelSlot[] = ["vision", "audio", "liveAudio", "decision"];
const NONE = "__none";

const slotHint = (t: AiAreaMessages, slot: AiModelSlot) =>
  isAiModelClass(slot)
    ? aiClassSubtitle(t, slot)
    : slot === "decision"
      ? t.slotd_decision
      : slot === "liveAudio"
        ? t.slotd_liveAudio
        : slot === "vision"
          ? t.slotd_vision
          : t.slotd_audio;

type Overview = AiClassesData["overview"];
type Provider = Overview["providers"][number];

/**
 * Model classes on v2: the four classes people choose from and the four tools of the Cloud as one table with the model
 * each one uses; the open one beside it with its choice, what happens when it is empty, who uses it and what people
 * see. The open slot lives in the address (`slot`).
 */
export default function ClassesScreen(props: { nav: NavProps; data: AiClassesData; appNames: Record<string, string> }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const data = () => props.data;
  const overview = () => data().overview;
  const providerOf = (model: AiModel): Provider | undefined => overview().providers.find((entry) => entry.id === model.providerId);
  const find = (variantId: string | null | undefined) => {
    const variant = data().variants.find((candidate) => candidate.id === variantId);
    const model = variant ? data().models.find((candidate) => candidate.id === variant.modelId) : undefined;
    const provider = model ? providerOf(model) : undefined;
    return variant && model && provider ? { variant, model, provider } : null;
  };
  const assigned = (slot: AiModelSlot) => overview().assignments[slot]?.variantId ?? null;
  const classCount = () => AI_MODEL_CLASSES.filter((slot) => assigned(slot)).length;
  const toolCount = () => TOOLS.filter((slot) => assigned(slot)).length;
  const nothing = () => data().models.length === 0;
  const issue = (slot: AiModelSlot) => {
    const found = find(assigned(slot));
    const state = found ? aiProviderState(found.provider) : "ok";
    return state === "unreachable" || state === "badkey" || state === "off" ? aiProviderStateLabel(t(), state) : null;
  };
  const emptyText = (slot: AiModelSlot) => {
    if (!isAiModelClass(slot)) return t().off;
    const effective = overview().effective[slot];
    return effective?.class ? t().clsUses({ p: aiSlotLabel(t(), effective.class) }) : t().clsUnassigned;
  };
  const rows = () => [...AI_MODEL_CLASSES, ...TOOLS];
  const open = () => data().slot;

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={open() ? 520 : undefined}
      head={
        <Bar
          start={
            <Path
              label={aiSectionLabel(locale(), "classes")}
              items={[aiAreaLink(locale()), { label: aiSectionLabel(locale(), "classes") }]}
            />
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={aiSectionLabel(locale(), "classes")}
          width={open() ? { min: 420, default: 600 } : undefined}
          scrollKey="admin-ai-classes"
          status={
            // k2b-ui gap: Hero figure (#4360); "n von 4 Klassen belegt" stands in the status row until the hero band exists
            <StatusRow
              lead={t().classesLead({ p: classCount() })}
              facts={[{ value: toolCount(), after: t().toolsSet({ of: TOOLS.length }) }]}
            />
          }
        >
          <Show when={classCount() === 0}>
            <Show
              when={!nothing()}
              fallback={
                <Notice
                  tone="note"
                  icon="stairs"
                  actions={[{ label: t().addProvider, icon: "plus", href: aiAreaHref({ sec: "providers" }, { o: "provider" }) }]}
                >
                  {t().clsEmptyNote}
                </Notice>
              }
            >
              <Notice tone="bad">{t().clsNoneAtAll}</Notice>
            </Show>
          </Show>
          <Table
            label={aiSectionLabel(locale(), "classes")}
            rows={rows()}
            rowKey={(slot) => slot}
            current={open() ?? undefined}
            group={(slot) =>
              isAiModelClass(slot)
                ? { key: "people", head: () => <Text weight="strong">{t().slots_people}</Text> }
                : { key: "cloud", head: () => <Text weight="strong">{t().slots_cloud}</Text> }
            }
            open={(slot) => ({ href: aiAreaHref({ sec: "classes", slot }) })}
            phone={(slot) => {
              const found = find(assigned(slot));
              return {
                // slot for #4208/#4223 (DP): the slot's mark in AI_COLOR leads the phone row
                lines: [
                  aiSlotLabel(t(), slot),
                  found ? `${aiVariantName(found.model, found.variant, data().variants)} · ${found.provider.label}` : emptyText(slot),
                ],
              };
            }}
            columns={[
              {
                title: t().colSlot,
                width: { min: 150, default: 180 },
                // slot for #4208/#4223 (DP): Column mark, the slot's symbol in AI_COLOR (fast bolt, balanced scale, thorough microscope, maximum rocket, vision photo, audio microphone, liveAudio microphone-2, decision route)
                cell: (slot) => aiSlotLabel(t(), slot),
              },
              {
                title: t().modelLabel,
                width: { min: 180, default: 240 },
                cell: (slot) => {
                  const found = find(assigned(slot));
                  return found ? (
                    // slot for #4208/#4223 (DP): the model's mark (its picture, or its kind's symbol in its provider's colour) before the name
                    <Text>{aiVariantName(found.model, found.variant, data().variants)}</Text>
                  ) : (
                    <Text
                      tone={isAiModelClass(slot) && !overview().effective[slot]?.class ? "bad" : undefined}
                      muted={!isAiModelClass(slot)}
                    >
                      {emptyText(slot)}
                    </Text>
                  );
                },
              },
              {
                title: t().colProvider,
                drop: true,
                cell: (slot) => {
                  const found = find(assigned(slot));
                  if (!found) return "";
                  const problem = issue(slot);
                  return problem ? (
                    <Text tone="bad" weight="medium">
                      <Icon name="point-filled" /> {`${found.provider.label} · ${problem}`}
                    </Text>
                  ) : (
                    found.provider.label
                  );
                },
              },
            ]}
          />
        </Pane>
        <Show when={open()} keyed>
          {(slot) => <SlotDetail slot={slot} data={data()} appNames={props.appNames} />}
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}

/** A5 detail: which model a class or tool uses, what happens when it is empty, who uses it, and what people see. */
function SlotDetail(props: { slot: AiModelSlot; data: AiClassesData; appNames: Record<string, string> }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const overview = () => props.data.overview;
  const [revision, setRevision] = createSignal(props.data.assignment?.revision ?? overview().assignments[props.slot]?.revision ?? 0);
  const [value, setValue] = createSignal(props.data.assignment?.variantId ?? overview().assignments[props.slot]?.variantId ?? null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiModelAssignment> | null>(null);
  const modelClass = (): AiModelClass | null => (isAiModelClass(props.slot) ? props.slot : null);
  const providers = () => overview().providers;
  const find = (variantId: string | null | undefined) => {
    const variant = props.data.variants.find((candidate) => candidate.id === variantId);
    const model = variant ? props.data.models.find((candidate) => candidate.id === variant.modelId) : undefined;
    const provider = model ? providers().find((candidate) => candidate.id === model.providerId) : undefined;
    return variant && model && provider ? { variant, model, provider } : null;
  };
  const name = (variantId: string | null | undefined) => {
    const found = find(variantId);
    return found ? aiVariantName(found.model, found.variant, props.data.variants) : t().clsUnassigned;
  };
  const assignments = () => overview().assignments;

  /** Only models that can fill this slot: chat for classes, image capability for the image tool, transcription for audio. */
  const choices = (provider: Provider): { variant: AiModelVariant; model: AiModel; others: AiModelSlot[] }[] =>
    props.data.variants.flatMap((variant) => {
      const model = props.data.models.find((candidate) => candidate.id === variant.modelId);
      // Classes and tools serve people, so models without a data-protection commitment never fill them.
      if (!model || model.providerId !== provider.id || !model.enabled || provider.dataBoundary === "restricted") return [];
      if (!aiModelSupportsSlot(props.slot, model)) return [];
      if (props.slot === "vision" && !model.capabilities.includes("vision")) return [];
      const others = (Object.keys(assignments()) as AiModelSlot[]).filter(
        (slot) => slot !== props.slot && assignments()[slot]?.variantId === variant.id,
      );
      return [{ variant, model, others }];
    });
  const emptyLabel = () => {
    const current = modelClass();
    if (!current) return t().off;
    const next = aiModelClassFallbackChain(current).find((entry) => assignments()[entry]?.variantId);
    return next ? `${t().clsUnassigned} · ${t().clsThenUses({ p: aiSlotLabel(t(), next) })}` : `${t().clsUnassigned} · ${t().clsThenNone}`;
  };

  const save = async (variantId: string | null, at = revision()) => {
    setSaving(true);
    setError("");
    setConflict(null);
    try {
      await readAiAdmin(
        await aiAdminApi.assignments[":slot"].$put({ param: { slot: props.slot }, json: { revision: at, variantId } }),
        t().saveFailed,
      );
      reloadAiArea();
    } catch (failure) {
      const found = asAiConflict(failure, AiAssignmentSchema);
      if (found) setConflict(found);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };
  const choose = (next: string) => {
    const variantId = next === NONE ? null : next;
    setValue(variantId);
    void save(variantId);
  };

  // k2b-ui gap: Select has no option groups and no second line; a Menu with one choice section per provider stands in
  const menu = (): MenuEntry[] => [
    {
      title: aiSlotLabel(t(), props.slot),
      choice: value() ?? NONE,
      onChoose: choose,
      items: [{ label: emptyLabel(), icon: "circle-off", value: NONE }],
    },
    ...providers()
      .filter((provider) => choices(provider).length > 0)
      .map(
        (provider): MenuEntry => ({
          title: provider.label,
          choice: value() ?? NONE,
          onChoose: choose,
          items: choices(provider).map(({ variant, model, others }) => {
            const state = aiProviderState(provider);
            return {
              value: variant.id,
              label: aiVariantName(model, variant, props.data.variants),
              color: aiProviderMark(provider).color,
              meta: [
                variant.reasoningEffort ? t().variantFallback({ p: effortLabel(t(), variant.reasoningEffort) }) : "",
                others.map((slot) => aiSlotLabel(t(), slot)).join(", "),
                state === "unreachable" ? t().stUnreach : state === "badkey" ? t().stBadKey : "",
              ]
                .filter(Boolean)
                .join(" · "),
            };
          }),
        }),
      ),
  ];

  const fallback = () => {
    const current = modelClass();
    return current ? overview().effective[current]?.class : null;
  };
  const chain = () => {
    const current = modelClass();
    return current ? [current, ...aiModelClassFallbackChain(current)] : [];
  };
  const stops = (): AiModelCardStop[] =>
    AI_MODEL_CLASSES.flatMap((entry) => {
      const id = entry === props.slot ? value() : assignments()[entry]?.variantId;
      const found = find(id);
      return found ? [{ class: entry, name: found.model.label, icon: aiModelDisplayIcon(found.model.icon, found.provider) }] : [];
    });
  /** People see this class when it has a model; an empty class is missing, so the card starts where people start. */
  const previewClass = (): AiModelClass | null => {
    const shown = stops();
    const own = modelClass();
    if (own && shown.some((stop) => stop.class === own)) return own;
    return shown.find((stop) => stop.class === "balanced")?.class ?? shown[0]?.class ?? null;
  };
  const usageRows = () => (props.data.assignment?.usage ?? []).filter((row) => row.class === props.slot);
  const nothing = () => props.data.models.length === 0;
  const current = () => find(value());

  return (
    <Pane
      detail
      label={aiSlotLabel(t(), props.slot)}
      back={{ label: aiSectionLabel(locale(), "classes"), href: aiAreaHref({ sec: "classes" }) }}
      scrollKey="admin-ai-slot"
      head={
        <Bar
          start={
            // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the slot's mark in AI_COLOR; the name stands in
            <Text type="body">{aiSlotLabel(t(), props.slot)}</Text>
          }
          end={<Button variant="ghost" icon="x" label={t().close} href={aiAreaHref({ sec: "classes" })} />}
        />
      }
    >
      <Show when={props.data.detailFailed}>
        <Notice
          tone="bad"
          title={t().loadFailTitle}
          primary={{ label: t().retry, icon: "refresh", onClick: () => window.location.reload() }}
        >
          {t().loadFailSub}
        </Notice>
      </Show>
      <Show when={conflict()}>
        {(found) => (
          <Notice
            tone="warn"
            icon="git-merge"
            title={
              found().changedBy
                ? t().conflictTitle({ name: found().changedBy!.name, time: formatAiTime(locale(), found().changedAt) })
                : t().conflictTitleUnknown
            }
            actions={[
              {
                label: t().takeTheirs,
                onClick: () => {
                  setRevision(found().current.revision);
                  setValue(found().current.variantId);
                  setConflict(null);
                },
              },
            ]}
            primary={{ label: t().keepMine, onClick: () => void save(value(), found().current.revision) }}
          >
            {t().clsConflict({ name: found().changedBy?.name ?? "", choice: name(found().current.variantId) })}
          </Notice>
        )}
      </Show>
      <Show when={nothing()}>
        <Notice
          tone="note"
          icon="stairs"
          actions={[{ label: t().addProvider, icon: "plus", href: aiAreaHref({ sec: "providers" }, { o: "provider" }) }]}
        >
          {t().clsEmptyNote}
        </Notice>
      </Show>
      <Show when={modelClass() && !value() && !nothing()}>
        <Show when={fallback()} fallback={<Notice tone="bad">{t().clsNoneAtAll}</Notice>}>
          {(next) => (
            <Notice tone="warn" icon="arrow-down-right">
              {t().clsFallbackNow({
                slot: aiSlotLabel(t(), props.slot),
                model: `${aiSlotLabel(t(), next())} (${name(overview().effective[next()]?.variantId)})`,
              })}
            </Notice>
          )}
        </Show>
      </Show>
      <Section icon="cube" title={t().assignment} summary={slotHint(t(), props.slot)}>
        <Facts
          items={[
            {
              label: t().modelLabel,
              // the choice stands where its value stands; a menu with one choice section per provider
              value: (
                <Menu label={t().chooseOther} variant="ghost" disabled={saving() || nothing()} items={menu()}>
                  {current() ? aiVariantName(current()!.model, current()!.variant, props.data.variants) : emptyLabel()}
                </Menu>
              ),
            },
            ...(current() ? [{ label: t().colProvider, value: current()!.provider.label }] : []),
          ]}
        />
      </Section>
      <Show when={modelClass()}>
        <Section icon="arrow-down-right" title={t().clsFallbackHead} summary={t().clsFallbackRule}>
          <Text>
            <For each={chain()}>
              {(entry, index) => (
                <>
                  {index() > 0 ? " › " : ""}
                  <Text weight={index() === 0 ? "strong" : undefined} muted={index() > 0 && !assignments()[entry]?.variantId}>
                    {aiSlotLabel(t(), entry)}
                    {index() > 0 && !assignments()[entry]?.variantId ? ` (${t().emptyWord})` : ""}
                  </Text>
                </>
              )}
            </For>
          </Text>
        </Section>
        <Section icon="users" title={t().clsUsersHead} count={usageRows().length + 1}>
          <Row icon="users" lines={[props.slot === "balanced" ? t().clsPeopleStart : t().clsPeople]} />
          <For each={usageRows()}>
            {(row) => (
              <Row
                icon="apps"
                lines={[[row.app ? (props.appNames[row.app] ?? row.app) : "Cloud", row.task].join(" · ")]}
                meta={t().callsIn14Days({ p: row.calls.toLocaleString(locale()) })}
              />
            )}
          </For>
        </Section>
        <Section icon="eye" title={t().clsPreview}>
          {/* k2b-ui gap: the people's model card is a v1 component of @k2b/cloud; it stands in a Canvas until it moves to v2 */}
          <Canvas label={t().clsPreview}>
            <AiModelCard stops={stops()} value={previewClass()} preview />
          </Canvas>
        </Section>
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
    </Pane>
  );
}

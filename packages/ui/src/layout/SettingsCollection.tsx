import { children, createMemo, createUniqueId, For, type JSX, Show } from "solid-js";
import { IconButton } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";

const SETTINGS_COLLECTION_ACTION = Symbol("SettingsCollection.Action");
const SETTINGS_COLLECTION_ITEM = Symbol("SettingsCollection.Item");
const SETTINGS_COLLECTION_ITEM_STATUS = Symbol("SettingsCollection.Item.Status");
const SETTINGS_COLLECTION_ITEM_ACTIONS = Symbol("SettingsCollection.Item.Actions");

type SlotDefinition<T extends symbol, P> = {
  readonly kind: T;
  readonly props: P;
};

export type SettingsCollectionProps = {
  title: JSX.Element;
  description?: JSX.Element;
  empty?: JSX.Element;
  children?: JSX.Element;
  class?: string;
};

export type SettingsCollectionActionProps = {
  children: JSX.Element;
};

export type SettingsCollectionItemProps = {
  title: JSX.Element;
  description?: JSX.Element;
  icon?: JSX.Element;
  children?: JSX.Element;
};

export type SettingsCollectionItemStatusProps = {
  children: JSX.Element;
};

export type SettingsCollectionItemActionsProps = {
  children: JSX.Element;
};

export type SettingsCollectionItemReorderProps = {
  label: string;
  index: number;
  count: number;
  disabled?: boolean;
  onMove: (direction: -1 | 1) => void;
};

type SettingsCollectionActionDefinition = SlotDefinition<typeof SETTINGS_COLLECTION_ACTION, SettingsCollectionActionProps>;
type SettingsCollectionItemDefinition = SlotDefinition<typeof SETTINGS_COLLECTION_ITEM, SettingsCollectionItemProps>;
type SettingsCollectionItemStatusDefinition = SlotDefinition<typeof SETTINGS_COLLECTION_ITEM_STATUS, SettingsCollectionItemStatusProps>;
type SettingsCollectionItemActionsDefinition = SlotDefinition<typeof SETTINGS_COLLECTION_ITEM_ACTIONS, SettingsCollectionItemActionsProps>;

type SettingsCollectionItemComponent = ((props: SettingsCollectionItemProps) => JSX.Element) & {
  Status: (props: SettingsCollectionItemStatusProps) => JSX.Element;
  Actions: (props: SettingsCollectionItemActionsProps) => JSX.Element;
  Reorder: (props: SettingsCollectionItemReorderProps) => JSX.Element;
};

type SettingsCollectionComponent = ((props: SettingsCollectionProps) => JSX.Element) & {
  Action: (props: SettingsCollectionActionProps) => JSX.Element;
  Item: SettingsCollectionItemComponent;
};

const definition = <T extends symbol, P>(kind: T, props: P): JSX.Element =>
  ({ kind, props }) satisfies SlotDefinition<T, P> as unknown as JSX.Element;

const isDefinition = <T extends symbol, P>(value: unknown, kind: T): value is SlotDefinition<T, P> =>
  Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === kind);

const collect = <T,>(value: unknown, match: (entry: unknown) => entry is T): T[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => collect(entry, match));
  return match(value) ? [value] : [];
};

const SettingsCollectionAction = (props: SettingsCollectionActionProps): JSX.Element => definition(SETTINGS_COLLECTION_ACTION, props);

const SettingsCollectionItemStatus = (props: SettingsCollectionItemStatusProps): JSX.Element =>
  definition(SETTINGS_COLLECTION_ITEM_STATUS, props);

const SettingsCollectionItemActions = (props: SettingsCollectionItemActionsProps): JSX.Element =>
  definition(SETTINGS_COLLECTION_ITEM_ACTIONS, props);

const SettingsCollectionItemReorder = (props: SettingsCollectionItemReorderProps): JSX.Element => {
  const messages = useUiMessages();
  return (
    <>
      <IconButton
        label={messages().moveNamedUp({ label: props.label })}
        size="sm"
        title={messages().moveUp}
        disabled={props.disabled || props.index <= 0}
        onClick={() => props.onMove(-1)}
      >
        <i class="ti ti-arrow-up" aria-hidden="true" />
      </IconButton>
      <IconButton
        label={messages().moveNamedDown({ label: props.label })}
        size="sm"
        title={messages().moveDown}
        disabled={props.disabled || props.index >= props.count - 1}
        onClick={() => props.onMove(1)}
      >
        <i class="ti ti-arrow-down" aria-hidden="true" />
      </IconButton>
    </>
  );
};

const SettingsCollectionItem = ((props: SettingsCollectionItemProps): JSX.Element =>
  definition(SETTINGS_COLLECTION_ITEM, props)) as SettingsCollectionItemComponent;

SettingsCollectionItem.Status = SettingsCollectionItemStatus;
SettingsCollectionItem.Actions = SettingsCollectionItemActions;
SettingsCollectionItem.Reorder = SettingsCollectionItemReorder;

const SettingsCollection = ((props: SettingsCollectionProps): JSX.Element => {
  const messages = useUiMessages();
  const resolved = children(() => props.children);
  const items = createMemo(() =>
    collect<SettingsCollectionItemDefinition>(resolved(), (entry): entry is SettingsCollectionItemDefinition =>
      isDefinition(entry, SETTINGS_COLLECTION_ITEM),
    ),
  );
  const action = createMemo(
    () =>
      collect<SettingsCollectionActionDefinition>(resolved(), (entry): entry is SettingsCollectionActionDefinition =>
        isDefinition(entry, SETTINGS_COLLECTION_ACTION),
      )[0],
  );
  const headingId = `k2b-settings-collection-${createUniqueId()}`;

  return (
    <section class={`k2b-settings-collection${props.class ? ` ${props.class}` : ""}`} aria-labelledby={headingId}>
      <header class="k2b-settings-collection__header">
        <div class="k2b-settings-collection__heading">
          <h3 id={headingId}>{props.title}</h3>
          <Show when={props.description}>
            <p>{props.description}</p>
          </Show>
        </div>
        <Show when={action()}>{(slot) => <div class="k2b-settings-collection__action">{slot().props.children}</div>}</Show>
      </header>
      <Show
        when={items().length > 0}
        fallback={<Placeholder variant="compact" align="left" description={props.empty ?? messages().nothingHere} />}
      >
        <ul class="k2b-settings-collection__list">
          <For each={items()}>
            {(item) => {
              const resolvedItem = children(() => item.props.children);
              const status = () =>
                collect<SettingsCollectionItemStatusDefinition>(resolvedItem(), (entry): entry is SettingsCollectionItemStatusDefinition =>
                  isDefinition(entry, SETTINGS_COLLECTION_ITEM_STATUS),
                )[0];
              const actions = () =>
                collect<SettingsCollectionItemActionsDefinition>(
                  resolvedItem(),
                  (entry): entry is SettingsCollectionItemActionsDefinition => isDefinition(entry, SETTINGS_COLLECTION_ITEM_ACTIONS),
                )[0];
              return (
                <li class="k2b-settings-collection__item">
                  <Show when={item.props.icon}>
                    <span class="k2b-settings-collection__item-icon">{item.props.icon}</span>
                  </Show>
                  <div class="k2b-settings-collection__item-copy">
                    <h4>{item.props.title}</h4>
                    <Show when={item.props.description}>
                      <p>{item.props.description}</p>
                    </Show>
                  </div>
                  <Show when={status()}>{(slot) => <div class="k2b-settings-collection__item-status">{slot().props.children}</div>}</Show>
                  <Show when={actions()}>{(slot) => <div class="k2b-settings-collection__item-actions">{slot().props.children}</div>}</Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}) as SettingsCollectionComponent;

SettingsCollection.Action = SettingsCollectionAction;
SettingsCollection.Item = SettingsCollectionItem;

export default SettingsCollection;

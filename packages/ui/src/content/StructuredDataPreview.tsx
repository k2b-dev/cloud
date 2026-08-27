import { createMemo, createSignal, For, Show } from "solid-js";
import CopyButton from "../actions/CopyButton";
import { type MaybeAccessor, resolveMaybeAccessor } from "../inputs/field-contract";
import { useUiMessages } from "../intl/messages";

export type StructuredDataPreviewMode = "formatted" | "raw";
export type StructuredDataValue =
  | null
  | boolean
  | number
  | string
  | readonly StructuredDataValue[]
  | { readonly [key: string]: StructuredDataValue };

export const isStructuredDataValue = (value: unknown, seen = new WeakSet<object>()): value is StructuredDataValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;

  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isStructuredDataValue(item, seen))
    : Object.values(value).every((item) => isStructuredDataValue(item, seen));
  seen.delete(value);
  return valid;
};

export type StructuredDataPreviewProps = {
  title?: string;
  data: StructuredDataValue;
  /** Controlled display mode. */
  mode?: MaybeAccessor<StructuredDataPreviewMode>;
  onModeChange?: (mode: StructuredDataPreviewMode) => void;
  /** Initial mode for an uncontrolled preview. */
  defaultMode?: StructuredDataPreviewMode;
  copy?: boolean;
  empty?: string;
  maxRows?: number;
  class?: string;
};

type Row = {
  key: string;
  value: StructuredDataValue;
};

const toRows = (data: StructuredDataValue): Row[] => {
  if (Array.isArray(data)) return data.map((value, index) => ({ key: String(index), value }));
  if (data && typeof data === "object") return Object.entries(data).map(([key, value]) => ({ key, value }));
  if (data === null) return [];
  return [{ key: "value", value: data }];
};

const formatInlineValue = (value: StructuredDataValue): string => {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

const formatJson = (data: StructuredDataValue): string => JSON.stringify(data, null, 2);

export default function StructuredDataPreview(props: StructuredDataPreviewProps) {
  const messages = useUiMessages();
  const [internalMode, setInternalMode] = createSignal<StructuredDataPreviewMode>(props.defaultMode ?? "formatted");
  const mode = () => (props.mode === undefined ? internalMode() : resolveMaybeAccessor(props.mode));
  const setMode = (next: StructuredDataPreviewMode) => {
    if (props.mode === undefined) setInternalMode(next);
    props.onModeChange?.(next);
  };
  const rows = createMemo(() => toRows(props.data));
  const visibleRows = createMemo(() => rows().slice(0, props.maxRows ?? rows().length));
  const hiddenCount = createMemo(() => Math.max(0, rows().length - visibleRows().length));
  const raw = createMemo(() => formatJson(props.data));
  const hasData = createMemo(() => rows().length > 0);
  const showRaw = createMemo(() => mode() === "raw");

  return (
    <div class={["k2b-content-structured-data", props.class].filter(Boolean).join(" ")}>
      <Show when={props.title}>{(title) => <h2 class="k2b-content-structured-data__title">{title()}</h2>}</Show>

      <Show
        when={!showRaw()}
        fallback={
          <div class="k2b-content-structured-data__surface" data-mode="raw">
            <pre>{raw()}</pre>
            <Show when={props.copy !== false}>
              <div class="k2b-content-structured-data__copy">
                <CopyButton text={raw()} />
              </div>
            </Show>
          </div>
        }
      >
        <div class="k2b-content-structured-data__surface">
          <Show when={hasData()} fallback={<p class="k2b-content-structured-data__empty">{props.empty ?? messages().noData}</p>}>
            <div class="k2b-content-structured-data__rows">
              <For each={visibleRows()}>
                {(row) => {
                  const complex = typeof row.value === "object" && row.value !== null;
                  return (
                    <>
                      <span class="k2b-content-structured-data__key" title={row.key}>
                        {row.key}
                      </span>
                      <span class="k2b-content-structured-data__value" data-complex={complex ? "true" : undefined}>
                        {formatInlineValue(row.value)}
                      </span>
                    </>
                  );
                }}
              </For>
            </div>
            <Show when={hiddenCount() > 0}>
              <p class="k2b-content-structured-data__hidden">
                {hiddenCount()} more row{hiddenCount() === 1 ? "" : "s"} hidden.
              </p>
            </Show>
          </Show>
        </div>
      </Show>

      <div class="k2b-content-structured-data__footer">
        <Show when={hasData()}>
          <button type="button" class="k2b-content-structured-data__action" onClick={() => setMode(showRaw() ? "formatted" : "raw")}>
            {showRaw() ? "View formatted" : "View raw"}
          </button>
        </Show>
      </div>
    </div>
  );
}

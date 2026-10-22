import { Combobox, type ComboboxOption, type FieldProps, TextInput, useLocale } from "@k2b/ui";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { invokeCapabilityWithDataSchema } from "../capabilities/client";
import { type GeoAddress, type GeoAvailabilityData, geoContract } from "../contracts/geo";
import { geoUiMessages } from "./messages";

type Budget = { scope: "person" | "cloud"; resetsAt: string };

export type AddressAutocompleteProps = Omit<FieldProps, "label"> & {
  label: JSX.Element;
  /** The street line as typed; the person's own text always stays possible. */
  value: string;
  onValueChange: (value: string) => void;
  /** A chosen suggestion. The host fills its fields from it and keeps point and provenance. */
  onPick: (address: GeoAddress) => void;
  /** The person keeps the typed text instead of a suggestion. */
  onOwnEntry?: (value: string) => void;
  /** From the SSR snapshot. Without a configured geo service the field is a plain text input. */
  availability?: GeoAvailabilityData;
  placeholder?: string;
  /** Icon of the plain text input when suggestions are off. */
  icon?: string;
};

/** Suggestions cost a credit each: 3–300 characters, 250 ms pause, at most 5, one request per field in flight. */
const MIN_TEXT = 3;
const MAX_TEXT = 300;
const LIMIT = 5;
const DEBOUNCE_MS = 250;
const OWN = "own";

// The list only opens in the browser, so the browser's zone is the reader's zone here.
const budgetText = (budget: Budget, locale: string, t: ReturnType<typeof geoUiMessages.resolve>["t"]) => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = new Date(budget.resetsAt);
  return budget.scope === "person"
    ? t.budgetPerson({ time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(at) })
    : t.budgetCloud({ date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone }).format(at) });
};

/** Address field with Cloud's budgeted suggestions; picking fills nothing by itself, the host owns its fields. */
export function AddressAutocomplete(props: AddressAutocompleteProps): JSX.Element {
  const locale = useLocale();
  const t = () => geoUiMessages.resolve([locale()]).t;
  const initialBudget = (): Budget | null => {
    const value = props.availability;
    if (value?.person.exhausted) return { scope: "person", ...value.person };
    if (value?.cloud.exhausted) return { scope: "cloud", ...value.cloud };
    return null;
  };
  const [budget, setBudget] = createSignal<Budget | null>(initialBudget());
  const [phone, setPhone] = createSignal(false);
  onMount(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });

  let suggestions: GeoAddress[] = [];
  let inflight: Promise<unknown> | undefined;
  const ownOption = (text: string): ComboboxOption => ({
    id: OWN,
    label: t().ownEntry({ text: text.trim() }),
    description: t().ownEntryDetail,
    icon: "ti ti-keyboard",
  });
  const withOwn = (text: string, options: ComboboxOption[]) => (phone() ? [ownOption(text), ...options] : [...options, ownOption(text)]);

  const countryName = (code: string) => {
    if (!code) return "";
    try {
      return new Intl.DisplayNames([locale()], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  const fetchData = async (text: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    if (text.trim().length > MAX_TEXT) return withOwn(text, []);
    // A newer query waits for the open request instead of cancelling a call Core may already have paid for.
    while (inflight) await inflight.catch(() => {});
    signal.throwIfAborted();
    const request = invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.autocomplete.id, input: { text, limit: LIMIT } },
      geoContract.autocomplete.data,
    );
    inflight = request;
    const result = await request.finally(() => {
      if (inflight === request) inflight = undefined;
    });
    if (!result.ok) {
      const details = result.error.details;
      if (
        result.error.code === "GEO_BUDGET_EXHAUSTED" &&
        (details?.scope === "person" || details?.scope === "cloud") &&
        typeof details.resetsAt === "string"
      ) {
        setBudget({ scope: details.scope, resetsAt: details.resetsAt });
        return [];
      }
      throw new Error(t().unavailable);
    }
    suggestions = result.data.data.suggestions.slice(0, LIMIT);
    if (!suggestions.length) return [];
    return withOwn(
      text,
      suggestions.map((address, index) => ({
        id: String(index),
        label: address.line1 || address.formatted,
        description: [[address.postalCode, address.city].filter(Boolean).join(" "), countryName(address.countryCode)]
          .filter(Boolean)
          .join(", "),
        icon: "ti ti-map-pin",
      })),
    );
  };

  const budgetStatus = () => {
    const value = budget();
    if (!value) return undefined;
    return (
      <span class="flex items-start gap-2">
        <i class="ti ti-hourglass" aria-hidden="true" />
        <span>
          <strong class="block font-medium">{budgetText(value, locale(), t())}</strong>
          {t().budgetDetail}
        </span>
      </span>
    );
  };

  return (
    <Show
      when={props.availability?.configured !== false}
      fallback={
        <TextInput
          id={props.id}
          class={props.class}
          label={props.label}
          description={props.description}
          error={props.error}
          required={props.required}
          disabled={props.disabled}
          placeholder={props.placeholder}
          icon={props.icon}
          value={() => props.value}
          onValueChange={props.onValueChange}
        />
      }
    >
      <Combobox
        id={props.id}
        class={props.class}
        label={props.label}
        description={props.description}
        error={props.error}
        required={props.required}
        disabled={props.disabled}
        aria-label={props["aria-label"]}
        aria-describedby={props["aria-describedby"]}
        placeholder={props.placeholder}
        freeText
        autoHighlight={phone() ? 1 : 0}
        minQueryLength={MIN_TEXT}
        debounceMs={DEBOUNCE_MS}
        query={() => props.value}
        onQueryChange={props.onValueChange}
        status={budgetStatus()}
        empty={
          <span>
            <strong class="block font-medium">{t().noMatch}</strong>
            {t().noMatchDetail}
          </span>
        }
        footer={
          <>
            <span>{phone() || budget() ? "" : t().keyboardHint}</span>
            <span>
              <a href="https://www.geoapify.com/" target="_blank" rel="noopener noreferrer">
                Geoapify
              </a>
              {" · "}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
                OpenStreetMap
              </a>
            </span>
          </>
        }
        fetchData={fetchData}
        onSelect={(option) => {
          if (option.id === OWN) return props.onOwnEntry?.(props.value);
          const address = suggestions[Number(option.id)];
          if (address) props.onPick(address);
        }}
      />
    </Show>
  );
}

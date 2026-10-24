import type { EntityListItem, ServiceAccountKind } from "@k2b/cloud/contracts/shared";
import { groupDisplayName } from "@k2b/cloud/shared";
import { MultiSelectInput, Select, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { type PrincipalReference, PrincipalReferenceSchema } from "../../../field-types/principal";
import { gridsFormMessages } from "./messages";

type PrincipalOption = PrincipalReference & { label: string; accountKind?: ServiceAccountKind };
type PrincipalChoice = { value: string; label: string; icon: string };

const keyOf = (value: PrincipalReference) => `${value.type}:${value.id}`;

const referenceOf = (value: string): PrincipalReference | null => {
  if (value.startsWith("user:")) return { type: "user", id: value.slice("user:".length) };
  if (value.startsWith("group:")) return { type: "group", id: value.slice("group:".length) };
  if (value.startsWith("service_account:")) return { type: "service_account", id: value.slice("service_account:".length) };
  return null;
};

const referenceArray = (value: unknown): PrincipalReference[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = PrincipalReferenceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
};

type EntityItem = EntityListItem;

const optionOf = (item: EntityItem, locale: string): PrincipalOption =>
  item.kind === "user"
    ? {
        type: "user",
        id: item.user.id,
        label: item.user.displayName || item.user.uid,
      }
    : item.kind === "service_account"
      ? { type: "service_account", id: item.serviceAccount.id, label: item.serviceAccount.name, accountKind: item.serviceAccount.kind }
      : {
          type: "group",
          id: item.group.id,
          label: groupDisplayName(item.group.name, locale),
        };

const choiceOf = (option: PrincipalOption): PrincipalChoice => ({
  value: keyOf(option),
  label: option.label,
  icon:
    option.type === "user"
      ? "ti ti-user"
      : option.type === "group"
        ? "ti ti-users-group"
        : option.accountKind === "agent"
          ? "ti ti-robot"
          : "ti ti-key",
});

export default function PrincipalInput(props: {
  name?: string;
  label: string;
  description?: string;
  required?: boolean;
  error?: () => string | undefined;
  value: unknown;
  multi: boolean;
  disabled?: boolean;
  types?: Array<PrincipalReference["type"]>;
  onChange: (value: PrincipalReference[] | null) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const principalGroups = () => [
    { value: "user", label: t().users },
    { value: "group", label: t().groups },
    { value: "service_account", label: t().serviceAccounts },
  ];
  const allowedTypes: PrincipalReference["type"][] = props.types ?? ["user", "group", "service_account"];
  const fallbackLabel = (type: PrincipalReference["type"]) =>
    type === "user" ? t().user : type === "group" ? t().group : t().serviceAccount;
  const accepts = (reference: PrincipalReference) => allowedTypes.includes(reference.type);
  const initial = referenceArray(props.value).filter(accepts);
  const [knownOptions, setKnownOptions] = createSignal<PrincipalOption[]>(
    initial.map((value) => ({ ...value, label: fallbackLabel(value.type) })),
  );

  const mergeOptions = (options: PrincipalOption[]) => {
    setKnownOptions((current) => {
      const merged = new Map(current.map((option) => [keyOf(option), option]));
      for (const option of options) merged.set(keyOf(option), option);
      return [...merged.values()];
    });
  };

  const fetchEntities = async (url: URL, signal: AbortSignal): Promise<PrincipalOption[]> => {
    const response = await fetch(url, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error(t().loadPrincipalsFailed);
    const body = (await response.json()) as { items?: EntityItem[] };
    const options = (body.items ?? []).map((item) => optionOf(item, locale()));
    mergeOptions(options);
    return options;
  };

  onMount(() => {
    if (initial.length === 0) return;
    const controller = new AbortController();
    const users = initial.filter((value) => value.type === "user").map((value) => value.id);
    const groups = initial.filter((value) => value.type === "group").map((value) => value.id);
    const accounts = initial.filter((value) => value.type === "service_account").map((value) => value.id);
    const url = new URL("/api/accounts/entities", window.location.origin);
    url.searchParams.set("kinds", [...new Set(initial.map((value) => value.type))].join(","));
    url.searchParams.set("per_page", String(initial.length));
    if (users.length) url.searchParams.set("user_ids", users.join(","));
    if (groups.length) url.searchParams.set("group_ids", groups.join(","));
    if (accounts.length) url.searchParams.set("service_account_ids", accounts.join(","));
    void fetchEntities(url, controller.signal).catch(() => undefined);
    onCleanup(() => controller.abort());
  });

  const references = () => referenceArray(props.value).filter(accepts);
  const values = () => references().map(keyOf);
  const selectedOptions = () => {
    const options = new Map(knownOptions().map((option) => [keyOf(option), option]));
    return references().map((reference) =>
      choiceOf(options.get(keyOf(reference)) ?? { ...reference, label: fallbackLabel(reference.type) }),
    );
  };
  const loadOptions = async (query: string, signal: AbortSignal, group: string | null): Promise<PrincipalChoice[]> => {
    if (query.trim().length < 2) return [];
    const requestedTypes =
      group === "user" || group === "group" || group === "service_account" ? allowedTypes.filter((type) => type === group) : allowedTypes;
    if (requestedTypes.length === 0) return [];
    const url = new URL("/api/accounts/entities", window.location.origin);
    url.searchParams.set("search", query.trim());
    url.searchParams.set("kinds", requestedTypes.join(","));
    url.searchParams.set("per_page", "10");
    return (await fetchEntities(url, signal)).map(choiceOf);
  };
  const commit = (next: string[]) => {
    const references = next.flatMap((value) => {
      const reference = referenceOf(value);
      return reference && accepts(reference) ? [reference] : [];
    });
    props.onChange(references.length ? references : null);
  };

  return props.multi ? (
    <MultiSelectInput
      name={props.name}
      label={props.label}
      description={props.description}
      required={props.required}
      error={props.error}
      disabled={props.disabled}
      value={values}
      onValueChange={commit}
      fetchData={loadOptions}
      selectedOptions={selectedOptions}
      groups={allowedTypes.length > 1 ? principalGroups() : undefined}
      groupsAriaLabel={t().filterPrincipals}
      placeholder={allowedTypes.length === 1 && allowedTypes[0] === "group" ? t().selectGroups : t().selectPrincipals}
      searchPlaceholder={allowedTypes.length === 1 && allowedTypes[0] === "group" ? t().searchGroups : t().searchPrincipals}
      noResultsLabel={allowedTypes.length === 1 && allowedTypes[0] === "group" ? t().noGroups : t().noPrincipals}
      clearable
    />
  ) : (
    <Select
      name={props.name}
      label={props.label}
      description={props.description}
      required={props.required}
      error={props.error}
      disabled={props.disabled}
      value={() => values()[0] ?? null}
      onValueChange={(value) => commit(value ? [value] : [])}
      fetchData={loadOptions}
      selectedOption={selectedOptions()[0]}
      groups={allowedTypes.length > 1 ? principalGroups() : undefined}
      groupsAriaLabel={t().filterPrincipals}
      placeholder={allowedTypes.length === 1 && allowedTypes[0] === "group" ? t().selectGroup : t().selectPrincipal}
      searchPlaceholder={allowedTypes.length === 1 && allowedTypes[0] === "group" ? t().searchGroups : t().searchPrincipals}
      clearable
    />
  );
}

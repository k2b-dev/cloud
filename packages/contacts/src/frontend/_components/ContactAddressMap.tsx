import type { GeoAvailabilityData, GeoPoint } from "@k2b/cloud/contracts/geo";
import { CloudMap, type GeoNavigationPlatform, geoNavigationHref, geoNavigationPlatform } from "@k2b/cloud/geo/ui";
import { Button, ButtonLink, useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ContactAddress } from "../../service";
import { detailMessages } from "./detail-messages";

const MAP_HEIGHT = 160;

export type AddressMapView =
  | { kind: "off" }
  | { kind: "locating" }
  | { kind: "found"; point: GeoPoint }
  | { kind: "not_found" }
  | { kind: "failed" }
  | { kind: "budget"; scope: "person" | "cloud"; resetsAt: string };

/** The state the server renders: Core's budget and setup first, then what the contact already knows. */
export const initialAddressMapView = (address: Pick<ContactAddress, "location">, availability?: GeoAvailabilityData): AddressMapView => {
  if (availability?.configured === false) return { kind: "off" };
  if (availability?.person.exhausted) return { kind: "budget", scope: "person", resetsAt: availability.person.resetsAt };
  if (availability?.cloud.exhausted) return { kind: "budget", scope: "cloud", resetsAt: availability.cloud.resetsAt };
  if (address.location?.status === "found") return { kind: "found", point: address.location.point };
  if (address.location?.status === "not_found") return { kind: "not_found" };
  return { kind: "locating" };
};

export const addressText = (address: Pick<ContactAddress, "line1" | "postalCode" | "city" | "countryCode">) =>
  [address.line1, [address.postalCode, address.city].filter(Boolean).join(" "), address.countryCode].filter(Boolean).join(", ");

/**
 * One lookup per address id for the whole page: the detail panel remounts its address rows whenever it reselects
 * the contact, and parallel requests could each reach the paid geocoder before the first answer is stored.
 */
const lookups = new Map<string, Promise<AddressMapView>>();
const requestLocation = async (bookId: string, contactId: string, addressId: string): Promise<AddressMapView> => {
  try {
    const response = await apiClient.books[":bookId"].contacts[":contactId"].addresses[":addressId"].locate.$post({
      param: { bookId, contactId, addressId },
    });
    if (!response.ok) return { kind: "failed" };
    const result = await response.json();
    if (result.state === "located")
      return result.location.status === "found" ? { kind: "found", point: result.location.point } : { kind: "not_found" };
    if (result.state === "budget_exhausted") return { kind: "budget", scope: result.scope, resetsAt: result.resetsAt };
    if (result.state === "not_configured") return { kind: "off" };
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
};

type Props = {
  bookId: string;
  contactId: string;
  contactName: string;
  address: ContactAddress;
  availability?: GeoAvailabilityData;
  /** The reader's zone from SSR, so server and browser print the same reset time. */
  timeZone: string;
  canEdit: boolean;
  onEdit: () => void;
};

/**
 * Mini map under one address with its navigation link. The map place is reserved from the first render; a pending
 * address is looked up once by the first authorized reader and every later state replaces only the message in it.
 */
export default function ContactAddressMap(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const [view, setView] = createSignal<AddressMapView>(initialAddressMapView(props.address, props.availability));
  // The server cannot know the device; the first render links to OpenStreetMap like a desktop.
  const [platform, setPlatform] = createSignal<GeoNavigationPlatform>("desktop");

  const locate = async (retry = false) => {
    setView({ kind: "locating" });
    if (retry) lookups.delete(props.address.id);
    let lookup = lookups.get(props.address.id);
    if (!lookup) {
      lookup = requestLocation(props.bookId, props.contactId, props.address.id);
      lookups.set(props.address.id, lookup);
    }
    const next = await lookup;
    // A failure may be retried; a stored answer comes back from the server without a new lookup.
    if (next.kind === "failed") lookups.delete(props.address.id);
    setView(next);
  };

  onMount(() => {
    setPlatform(geoNavigationPlatform(navigator.userAgent));
    if (view().kind === "locating") void locate();
  });

  const point = () => {
    const current = view();
    return current.kind === "found" ? current.point : null;
  };
  const markers = createMemo(() => {
    const value = point();
    return value ? [{ id: props.address.id, point: value, label: addressText(props.address), selected: true }] : [];
  });
  const resetText = (budget: { scope: "person" | "cloud"; resetsAt: string }) => {
    const at = new Date(budget.resetsAt);
    const time = new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit", timeZone: props.timeZone }).format(at);
    if (budget.scope === "person") return t().addressMapBudgetPerson({ time });
    const date = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", timeZone: props.timeZone }).format(at);
    return t().addressMapBudgetCloud({ date, time });
  };
  const message = (): JSX.Element | null => {
    const current = view();
    switch (current.kind) {
      case "locating":
        return (
          <>
            <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
            {t().addressMapLoading}
          </>
        );
      case "not_found":
        return (
          <>
            <i class="ti ti-map-pin-off" aria-hidden="true" />
            {t().addressMapNotFound}
          </>
        );
      case "failed":
        return (
          <>
            <i class="ti ti-alert-triangle" aria-hidden="true" />
            {t().addressMapFailed} ·
            <Button variant="text" size="xs" onClick={() => void locate(true)}>
              {t().tryAgain}
            </Button>
          </>
        );
      case "budget":
        return (
          <>
            <i class="ti ti-hourglass" aria-hidden="true" />
            {resetText(current)}
          </>
        );
      default:
        return null;
    }
  };
  const href = () => geoNavigationHref({ point: point(), text: addressText(props.address), name: props.contactName }, platform());

  return (
    <>
      <Show when={view().kind !== "off"}>
        <div class="relative mt-2 overflow-hidden rounded-xl">
          <CloudMap height={MAP_HEIGHT} availability={props.availability} markers={markers()} />
          <Show when={message()}>
            {(content) => (
              <div class="pointer-events-none absolute inset-0 grid place-items-center p-4">
                <span
                  class="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full bg-[var(--k2b-surface)] px-3.5 py-1.5 text-[13px] text-secondary shadow-[0_1px_4px_rgb(0_0_0/0.12)]"
                  role={view().kind === "failed" ? "alert" : "status"}
                >
                  {content()}
                </span>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <div class="mt-2 flex flex-wrap gap-2">
        {/* geo: hands over to the Android maps app; web links open beside Cloud. */}
        <ButtonLink
          href={href()}
          target={platform() === "android" ? undefined : "_blank"}
          rel="noopener noreferrer"
          variant="secondary"
          size="sm"
        >
          <i class="ti ti-directions" aria-hidden="true" /> {t().planRoute}
        </ButtonLink>
        <Show when={props.canEdit}>
          <Button variant="secondary" size="sm" onClick={() => props.onEdit()} data-contact-address-edit={props.address.id}>
            <i class="ti ti-pencil" aria-hidden="true" /> {t().editAddress}
          </Button>
        </Show>
      </div>
    </>
  );
}

import { importOnDemand } from "@k2b/cloud/browser/reload";
import { navigateTo } from "@k2b/ssr/nav";
import {
  type AppWorkspaceSidebarSwitcherProps,
  type AppWorkspaceSwitcherOption,
  dialogCore,
  panelDialogOptions,
  toast,
  useLocale,
} from "@k2b/ui";
import { type Accessor, createSignal } from "solid-js";
import { apiClient } from "../../api/client";
import { VENUE_PAGE_MAX, type Venue } from "../../contracts";
import { venueMessages } from "../../messages";

/** The venue's sidebar switcher for the sidebar and the phone menu; the other venues load when it is first reached. */
export function createVenueSwitcher(
  venue: Accessor<Pick<Venue, "id" | "name" | "icon" | "accentColor">>,
  canCreate: boolean,
): Accessor<AppWorkspaceSidebarSwitcherProps> {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [options, setOptions] = createSignal<AppWorkspaceSwitcherOption[]>();
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const [creating, setCreating] = createSignal(false);
  const create = async () => {
    if (!canCreate || creating()) return;
    setCreating(true);
    try {
      // The dialog is only for this action, so its code loads when someone asks for a new venue.
      const dialog = await importOnDemand(() => import("./create-venue-dialog"));
      if (!dialog) return;
      const id = await dialogCore.open<string | null>(
        (close, context) => <dialog.CreateVenueDialog close={close} guardDismiss={context.setDismissHandler} />,
        panelDialogOptions,
      );
      if (!id) return;
      toast.success(t().venueCreated);
      navigateTo(`/app/venue/${id}`);
    } finally {
      setCreating(false);
    }
  };
  const load = async () => {
    if (requested) return;
    requested = true;
    setFailed(false);
    try {
      // Every venue, page by page, until a page is short or brings no venue already seen; listed by name.
      const venues = new Map<string, Pick<Venue, "id" | "name" | "icon" | "accentColor">>();
      for (let offset = 0; ; offset += VENUE_PAGE_MAX) {
        const response = await apiClient.venues.$get({ query: { limit: String(VENUE_PAGE_MAX), offset: String(offset) } });
        if (!response.ok) throw new Error();
        const payload = await response.json();
        if (!("venues" in payload)) throw new Error();
        const before = venues.size;
        for (const item of payload.venues) if (!venues.has(item.id)) venues.set(item.id, item);
        if (payload.venues.length !== VENUE_PAGE_MAX || venues.size === before) break;
      }
      setOptions(
        [...venues.values()]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((item) => ({
            id: item.id,
            label: item.name,
            icon: item.icon,
            color: item.accentColor,
            href: `/app/venue/${item.id}`,
          })),
      );
    } catch {
      requested = false;
      setFailed(true);
    }
  };
  return () => ({
    currentId: venue().id,
    label: venue().name,
    icon: venue().icon,
    color: venue().accentColor,
    switchLabel: t().switchVenue,
    options: options(),
    error: failed() ? t().failedLoadVenues : undefined,
    onLoad: () => void load(),
    actions: [
      ...(canCreate ? [{ id: "new", label: t().newVenue, icon: "ti ti-plus", action: () => void create(), disabled: creating() }] : []),
      { id: "all", label: t().allVenues, icon: "ti ti-layout-grid", href: "/app/venue" },
    ],
  });
}

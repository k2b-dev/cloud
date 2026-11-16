import { BottomSheet, Navigation, SegmentedControl, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { type AppLaunchpadContext, AppLaunchpadPanel } from "./AppLaunchpadPanel";
import { appAccentStyle } from "./app-appearance";
import { anyAppBadge } from "./app-badges";
import { openMobileMenu } from "./mobile-menu-history";
import { platformMessages } from "./platform-messages";
import { railMessages } from "./rail-messages";
import { readShellData } from "./shell-data";
import { observeWorkspaceNavigation, readWorkspaceNavigation } from "./workspace-navigation";

/** The sheet's "All apps" tab name, with the header's news dot while any app has a count. */
export function AllAppsLabel(props: { news: boolean }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const rail = () => railMessages.resolve([locale()]).t;
  return (
    <span class="cloud-mobile-menu__apps" data-news={props.news ? "" : undefined}>
      <span class="block k2b-truncate-fade">{t().allApps}</span>
      <span class="cloud-launchpad-dot" aria-hidden="true" />
      <Show when={props.news}>
        <span class="sr-only">, {rail().newInApps}</span>
      </Show>
    </span>
  );
}

export function openCloudMobileMenu(apps: AppLaunchpadContext) {
  return openMobileMenu((beforeSelect) => (close, context) => (
    <MobileNavigation apps={apps} beforeSelect={beforeSelect} close={close} dismiss={context.requestDismiss} />
  ));
}

function MobileNavigation(props: {
  apps: AppLaunchpadContext;
  beforeSelect: () => Promise<boolean>;
  close: () => void;
  dismiss: () => Promise<void>;
}) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const [workspace, setWorkspace] = createSignal(readWorkspaceNavigation());
  const [tab, setTab] = createSignal<"app" | "apps">("app");
  // A new wrapper signal version propagates in-place updates of the owner snapshot.
  onCleanup(
    observeWorkspaceNavigation(() =>
      setWorkspace(() => {
        const next = readWorkspaceNavigation();
        return next ? { ...next } : undefined;
      }),
    ),
  );
  return (
    <BottomSheet onDismiss={props.dismiss}>
      {/* Without an app menu the launchpad gets the whole sheet; the hidden
          heading still names the dialog, and the handle and backdrop dismiss it. */}
      <Show when={workspace()} fallback={<h2 class="sr-only">{t().allApps}</h2>}>
        <BottomSheet.Header
          title={workspace()?.label || t().apps}
          close={() => void props.dismiss()}
          actions={
            <SegmentedControl
              class="cloud-mobile-menu__switch"
              size="md"
              ariaLabel={t().navigation}
              value={tab}
              onValueChange={setTab}
              options={[
                { value: "app", label: <span class="block k2b-truncate-fade">{workspace()?.label || t().appMenu}</span> },
                {
                  value: "apps",
                  // The header's dot leads here: the counts behind it are in this tab, so it carries the same dot.
                  label: <AllAppsLabel news={anyAppBadge(props.apps.apps)} />,
                },
              ]}
            />
          }
        />
      </Show>
      <BottomSheet.Body>
        <Show
          when={workspace() && tab() === "app"}
          fallback={<AppLaunchpadPanel surface="sheet" {...props.apps} close={props.close} beforeSelect={props.beforeSelect} />}
        >
          {/* The sheet opens outside the app canvas, so the app menu takes the app's accent here, as the canvas does. */}
          <div class="app-accent-scope" style={appAccentStyle(readShellData()?.accent)}>
            <Navigation
              navigation={workspace()!.navigation}
              label={workspace()!.label || t().appMenu}
              beforeSelect={async () => {
                const owner = workspace()?.owner;
                return (await props.beforeSelect()) && Boolean(owner?.isConnected && readWorkspaceNavigation()?.owner === owner);
              }}
            />
          </div>
        </Show>
      </BottomSheet.Body>
    </BottomSheet>
  );
}

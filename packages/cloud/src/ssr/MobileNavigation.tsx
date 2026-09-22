import { BottomSheet, Navigation, SegmentedControl, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { type AppLaunchpadContext, AppLaunchpadPanel } from "./AppLaunchpadPanel";
import { openMobileMenu } from "./mobile-menu-history";
import { platformMessages } from "./platform-messages";
import { observeWorkspaceNavigation, readWorkspaceNavigation } from "./workspace-navigation";

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
                { value: "app", label: workspace()?.label || t().appMenu },
                { value: "apps", label: t().allApps },
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
          <Navigation
            navigation={workspace()!.navigation}
            label={workspace()!.label || t().appMenu}
            beforeSelect={async () => {
              const owner = workspace()?.owner;
              return (await props.beforeSelect()) && Boolean(owner?.isConnected && readWorkspaceNavigation()?.owner === owner);
            }}
          />
        </Show>
      </BottomSheet.Body>
    </BottomSheet>
  );
}

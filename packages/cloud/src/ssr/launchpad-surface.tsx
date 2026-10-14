import { dialogCore } from "@k2b/ui";
import { type AppLaunchpadContext, AppLaunchpadPanel } from "./AppLaunchpadPanel";
import { openCloudMobileMenu } from "./MobileNavigation";

export function openLaunchpadSurface(context: AppLaunchpadContext) {
  if (window.matchMedia("(max-width: 767px)").matches) {
    void openCloudMobileMenu(context);
    return;
  }
  void dialogCore.open<void>((close) => <AppLaunchpadPanel apps={context.apps} legalLinks={context.legalLinks} close={close} />, {
    panelClassName: "k2b-dialog k2b-dialog--large is-bare",
    contentClassName: "k2b-dialog__viewport is-bare",
    initialFocus: (dialog) => dialog.querySelector<HTMLAnchorElement>("a[href]"),
  });
}

import { openCloudMobileMenu } from "@k2b/cloud/ssr/MobileNavigation";
import { render } from "solid-js/web";

// The shell's phone menu as Cloud's phone bar opens it ("Mail ⌄"), for the v2 fixture page, which has no shell: a
// button that opens the real menu; the menu reads the navigation the page's island registered. It carries no words:
// the test finds it by its attribute, and nothing of it is UI text.
const host = document.createElement("div");
document.body.append(host);
render(() => <button type="button" data-mail-v2-phone-menu onClick={() => void openCloudMobileMenu({ apps: [], legalLinks: [] })} />, host);

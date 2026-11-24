import { openCloudMobileMenu } from "@k2b/cloud/ssr/MobileNavigation";
import { render } from "solid-js/web";

// The shell's phone menu as Cloud's phone bar opens it ("Mail ⌄"), for the v2 fixture page, which has no shell: a
// button that opens the real menu; the menu reads the navigation the page's island registered.
const host = document.createElement("div");
document.body.append(host);
render(() => <button onClick={() => void openCloudMobileMenu({ apps: [], legalLinks: [] })}>Menü öffnen</button>, host);

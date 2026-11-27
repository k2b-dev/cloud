import type { NavProps } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import { OAuthFixture } from "./oauth-fixture";

/**
 * The screen from invented clients inside the real page, for pictures of its dialogs: it takes the place of the page's
 * island, under the shell's own rail, with the admin navigation the page itself got (`#shell-nav`).
 */
const island = document.querySelector('solid-island[data-file="OAuthScreen.island.tsx"]');
const navData = document.getElementById("shell-nav")?.textContent;
if (!island || !navData) throw new Error("The page has no OAuth island or no navigation");
const nav: NavProps = JSON.parse(navData);
island.replaceChildren();
render(() => <OAuthFixture search={location.search} nav={nav} />, island);
document.body.dataset.ready = "true";

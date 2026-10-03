/**
 * Gives the browser chrome the page's current background after a theme change: the `html` background, which iOS
 * shows behind the status bar and in overscroll, and every `theme-color` meta element. A `media` attribute is
 * dropped, because the page's chosen theme wins over the system scheme. Browser-only.
 */
export function syncThemeColor(root?: Element): void {
  const source = root ?? document.querySelector(".k2b-ui") ?? document.body;
  const color = getComputedStyle(source).backgroundColor;
  document.documentElement.style.backgroundColor = color;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.removeAttribute("media");
    meta.content = color;
  }
}

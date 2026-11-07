/** Runs in the browser; semantic blue exceptions never exempt a focus indicator. */
export async function auditPrimaryColors(input: string | { selector: string; focus: boolean }): Promise<string[]> {
  const selector = typeof input === "string" ? input : input.selector;
  const canvas = document.createElement("canvas").getContext("2d")!;
  const cache = new Map<string, number[]>();
  const rgba = (value: string) => {
    let channels = cache.get(value);
    if (!channels) {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = value;
      canvas.fillRect(0, 0, 1, 1);
      const alpha = canvas.getImageData(0, 0, 1, 1).data[3]!;
      // Read hue without premultiplied-alpha rounding (a near-black 5% shadow must stay neutral).
      canvas.fillStyle = `rgb(from ${value} r g b / 1)`;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillRect(0, 0, 1, 1);
      channels = [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3), alpha];
      cache.set(value, channels);
    }
    return channels;
  };
  const rootStyle = getComputedStyle(document.querySelector(".k2b-ui")!);
  const neutrals = new Set(
    [
      "surface",
      "surface-canvas",
      "surface-muted",
      "surface-elevated",
      "text",
      "text-secondary",
      "text-muted",
      "border",
      "border-strong",
      "placeholder-color",
    ]
      .map((name) => rootStyle.getPropertyValue(`--k2b-${name}`).trim())
      .filter((value) => CSS.supports("color", value))
      .map((value) => rgba(value).slice(0, 3).join(",")),
  );
  const blue = (value: string) => {
    const [red = 0, green = 0, blue = 0, alpha = 0] = rgba(value);
    if (!alpha || neutrals.has([red, green, blue].join(","))) return false;
    const max = Math.max(red, green, blue),
      min = Math.min(red, green, blue),
      delta = max - min;
    if (!delta) return false;
    const lightness = (max + min) / 510;
    const saturation = delta / 255 / (1 - Math.abs(2 * lightness - 1));
    const hue =
      ((max === red ? (green - blue) / delta : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4) * 60 + 360) % 360;
    return hue >= 205 && hue <= 245 && saturation >= 0.3;
  };
  const exceptions = [
    ".k2b-file-type-icon",
    ".k2b-avatar[data-tint]",
    ".k2b-choice-dot",
    ".k2b-choice-tiles__visual",
    ".k2b-color-choices__swatch",
    ".k2b-dropdown__color",
    ".k2b-detail-presence__activity",
    ".k2b-detail-presence__swatch",
    ".k2b-chart",
    ".k2b-country-map__scale",
    ".k2b-data-table__bar-track",
    "[style*='--k2b-detail-panel-accent']",
    ".cd-param",
    ".cd-number",
    ".cd-string",
    ".k2b-color-choices",
    ".k2b-color-input__swatch",
    ".k2b-resource-card__icon",
    ".k2b-stat-cell__icon[data-tone='blue']",
    "[data-tone='blue']",
    "[data-color='blue']",
    "[style*='--k2b-choice-color']",
    ".k2b-content-code-display__body",
    ".k2b-code-viewer code",
    ".k2b-doc-code code",
    ".k2b-content-doc-code",
    ".k2b-template-tag",
    ".stdlib-chart",
    ".k2b-chart__svg",
    ".k2b-country-map svg",
    ".k2b-map-view__me",
    ".k2b-map-view__accuracy",
  ].join(",");
  const properties = [
    "color",
    "background-color",
    "background-image",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "box-shadow",
    "fill",
    "stroke",
    "caret-color",
    "accent-color",
    "text-decoration-color",
  ];
  const values = new Map<string, boolean>();
  const hasBlue = (value: string) => {
    const cached = values.get(value);
    if (cached !== undefined) return cached;
    const colours = CSS.supports("color", value)
      ? [value]
      : (value.match(/(?:rgba?|hsla?|color|oklch|oklab|lab|lch)\([^)]*\)|#[\da-f]{3,8}/gi) ?? []);
    const result = colours.some(blue);
    values.set(value, result);
    return result;
  };
  const leaks = new Set<string>();
  const baseline = new Map<Element, Map<string, string>>();
  const audit = (nodes: Iterable<Element>, focusing = false) => {
    for (const node of nodes) {
      const exempt = node.closest(exceptions) !== null;
      const initial = baseline.get(node) ?? new Map<string, string>();
      if (!focusing) baseline.set(node, initial);
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(node, pseudo);
        if (pseudo && (style.content === "none" || style.content === "normal")) continue;
        for (const property of properties) {
          const value = style.getPropertyValue(property);
          const key = `${pseudo ?? ""}/${property}`;
          if (!focusing) initial.set(key, value);
          // Keyboard inspection draws series-coloured crosshairs. Their two
          // dashed pseudo-element edges encode data, rather than focus scope.
          if (
            ((pseudo === "::after" && property === "border-left-color") || (pseudo === "::before" && property === "border-top-color")) &&
            node.matches(".k2b-chart[data-inspecting='series']")
          )
            continue;
          // Object and series paint stays explicit. A focus outline or a newly
          // blue border/shadow is still a leak, even inside an exempt object.
          if (exempt && property !== "outline-color") {
            if (!focusing || (property !== "box-shadow" && !property.startsWith("border-")) || initial.get(key) === value) continue;
          }
          if (property === "outline-color" && (style.outlineStyle === "none" || style.outlineWidth === "0px")) continue;
          if (property.startsWith("border-") && style.getPropertyValue(property.replace("color", "width")) === "0px") continue;
          if (hasBlue(value)) leaks.add(`${node.tagName}.${String(node.className)} ${pseudo ?? ""} ${property}=${value}`);
        }
      }
    }
  };
  const nodes = [...document.querySelectorAll(selector)];
  if (typeof input !== "string" && input.focus && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  audit(nodes);
  if (typeof input !== "string" && input.focus) {
    const focusables = nodes.filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement &&
        node.matches("button,a[href],input,select,textarea,[tabindex],[contenteditable='true']") &&
        !node.matches(":disabled") &&
        !node.closest("[inert]") &&
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === "visible",
    );
    const roots = new Set(nodes);
    for (const target of focusables) {
      // The caller establishes keyboard modality once. Programmatic focus then
      // retains :focus-visible without rewriting a composite's roving tabindex.
      target.focus({ preventScroll: true });
      await Promise.resolve(); // Allow queued focus delegation to finish.
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement) continue;
      const focused = new Set<Element>([active, ...active.querySelectorAll("*")]);
      for (let ancestor = active.parentElement; ancestor && roots.has(ancestor); ancestor = ancestor.parentElement) focused.add(ancestor);
      // Input shells can draw a ring on an adjacent sibling.
      if (active.previousElementSibling) focused.add(active.previousElementSibling);
      if (active.nextElementSibling) focused.add(active.nextElementSibling);
      // Focus pseudo-classes apply synchronously; computed style resolves their
      // paint here. Transitions and animations are disabled in this fixture.
      audit(focused, true);
    }
  }
  return [...leaks];
}

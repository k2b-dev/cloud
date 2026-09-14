/** Apply controls through the same query-text boundary in the compiler, SSR and browser. */
export const resolveDashboardControls = (
  text: string,
  controls: readonly { variable: string; defaultValue: string }[],
  values: Readonly<Record<string, string>> = {},
): string => {
  const replacements = new Map(controls.map((control) => [control.variable, values[control.variable] ?? control.defaultValue]));
  return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, variable: string) => {
    const value = replacements.get(variable);
    if (value === undefined) return match;
    return /[\s,="'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
  });
};

/**
 * A notebook's stored icon ("ti ti-bulb", the v1 class form) as the Tabler name v2 takes ("bulb"); `fallback` when the
 * notebook chose none.
 */
export const v2Icon = (stored: string | null | undefined, fallback: string): string => {
  const name = stored
    ?.trim()
    .split(/\s+/)
    .find((part) => part.startsWith("ti-") && part !== "ti");
  return name ? name.slice(3) : fallback;
};

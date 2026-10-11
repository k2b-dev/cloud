export const localToolTarget = (name: string, args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const count = (items: unknown[], unit: string) => `${items.length} ${unit}${items.length === 1 ? "" : "s"}`;
  if (name === "local_upload" && "paths" in args && Array.isArray(args.paths)) return count(args.paths, "file");
  if (name === "local_move" && "moves" in args && Array.isArray(args.moves)) return count(args.moves, "move");
  const value =
    name === "local_download"
      ? "to" in args
        ? args.to
        : undefined
      : name === "load_local_skill"
        ? "name" in args
          ? args.name
          : undefined
        : "path" in args
          ? args.path
          : undefined;
  const folder = typeof value === "string" && value !== "." ? `${value.replace(/\/+$/, "")}/` : "";
  const target = name === "local_list" && "pattern" in args && typeof args.pattern === "string" ? folder + args.pattern : value;
  const mode = name === "local_write" && "mode" in args && typeof args.mode === "string" ? ` (${args.mode})` : "";
  return typeof target === "string" ? target + mode : name === "local_list" ? "." : "";
};

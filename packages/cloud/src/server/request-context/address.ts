import { isUnsafeNetworkAddress, parseNetworkAddress } from "../../shared/network-address";

const ADDRESS_BUDGET = 64;

export const publicClientAddress = (raw: string | null | undefined): string | null => {
  try {
    const input = raw?.trim();
    if (!input || input.length > ADDRESS_BUDGET) return null;
    if (input.includes("[") || input.includes("]")) return null;
    const parsed = parseNetworkAddress(input);
    if (!parsed || isUnsafeNetworkAddress(parsed.address)) return null;
    if (parsed.family === 6 && parsed.address.startsWith("::ffff:")) {
      const groups = parsed.address.slice(7).split(":");
      const high = Number.parseInt(groups[0] ?? "", 16);
      const low = Number.parseInt(groups[1] ?? "", 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join(".");
    }
    return parsed.address;
  } catch {
    return null;
  }
};

export const addressPrefix = (address: string): string | null => {
  const canonical = publicClientAddress(address);
  if (!canonical) return null;
  if (!canonical.includes(":")) return canonical;
  const [left = "", right = ""] = canonical.split("::");
  const leading = left ? left.split(":") : [];
  const trailing = right ? right.split(":") : [];
  const groups = [...leading, ...Array<string>(8 - leading.length - trailing.length).fill("0"), ...trailing];
  const prefix = parseNetworkAddress(`${groups.slice(0, 4).join(":")}:0:0:0:0`);
  return prefix ? `${prefix.address}/64` : null;
};

import { isUnsafeNetworkAddress, parseNetworkAddress } from "../../shared/network-address";

const ADDRESS_BUDGET = 64;

const ipv6Groups = (address: string): number[] => {
  const [left = "", right = ""] = address.split("::");
  const leading = left ? left.split(":") : [];
  const trailing = right ? right.split(":") : [];
  return [...leading, ...Array<string>(8 - leading.length - trailing.length).fill("0"), ...trailing].map((group) =>
    Number.parseInt(group, 16),
  );
};

export const publicClientAddress = (raw: string | null | undefined): string | null => {
  try {
    const input = raw?.trim();
    if (!input || input.length > ADDRESS_BUDGET) return null;
    if (input.includes("[") || input.includes("]")) return null;
    const parsed = parseNetworkAddress(input);
    if (!parsed || isUnsafeNetworkAddress(parsed.address)) return null;
    if (parsed.family === 6) {
      const groups = ipv6Groups(parsed.address);
      if (
        [0, 0, 0, 0, 0, 0xffff].every((group, index) => groups[index] === group) ||
        [0x64, 0xff9b, 0, 0, 0, 0].every((group, index) => groups[index] === group)
      ) {
        const high = groups[6]!;
        const low = groups[7]!;
        return [high >> 8, high & 255, low >> 8, low & 255].join(".");
      }
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
  const groups = ipv6Groups(canonical).map((group) => group.toString(16));
  const prefix = parseNetworkAddress(`${groups.slice(0, 4).join(":")}:0:0:0:0`);
  return prefix ? `${prefix.address}/64` : null;
};

import { isIP } from "node:net";

/** Canonical socket/proxy identity, including IPv4-mapped IPv6 aliases. */
export function canonicalAddress(address: string): string {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) throw new Error("Invalid IP address");
  let text = address.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (tail) {
    const parts = tail.split(".").map(Number);
    text = `${text.slice(0, -tail.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = (halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left).map((word) =>
    Number.parseInt(word, 16),
  );
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`;
  return words.map((word) => word.toString(16)).join(":");
}

/** One IPv4 address or IPv6 /64: rotating interface identifiers keeps one budget. */
export function addressBudgetKey(address: string): string {
  const canonical = canonicalAddress(address);
  return canonical.includes(":") ? `${canonical.split(":").slice(0, 4).join(":")}::/64` : canonical;
}

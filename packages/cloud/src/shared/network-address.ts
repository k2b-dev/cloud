const ipv4ToNumber = (address: string): number | null => {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.some((part) => part > 255)) return null;
  return values.reduce((value, part) => (value * 256 + part) >>> 0, 0);
};

const ipv4InRange = (address: string, base: string, bits: number): boolean => {
  const value = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  if (value === null || baseValue === null) return true;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
};

const UNSAFE_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

// Only canonical IPv6 from the WHATWG parser reaches this conversion.
const ipv6ToBigInt = (address: string): bigint => {
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
};

const ipv6InRange = (address: bigint, base: bigint, bits: number): boolean => {
  const shift = BigInt(128 - bits);
  return address >> shift === base >> shift;
};

const UNSAFE_IPV6_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [ipv6ToBigInt("2001::"), 23],
  [ipv6ToBigInt("2001:db8::"), 32],
  [ipv6ToBigInt("2002::"), 16],
  [ipv6ToBigInt("3fff::"), 20],
];

export const normalizeNetworkHostname = (hostname: string): string => {
  const lower = hostname.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]") && lower.includes(":")) return lower.slice(1, -1);
  return lower.includes(":") ? lower : lower.replace(/\.$/, "");
};

// WHATWG's "ends in a number" rule: these hosts must parse as IPv4,
// rather than falling back to DNS (including invalid octal and overflow).
const endsInNumber = (hostname: string): boolean => {
  const last = hostname.split(".").at(-1) ?? "";
  return /^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last);
};

/** Parse all URL IP literal forms without DNS or server-only dependencies. */
export const parseNetworkAddress = (rawAddress: string): { address: string; family: 4 | 6 } | null => {
  const address = normalizeNetworkHostname(rawAddress);
  const ipv6 = address.includes(":");
  if (!address || /[\s/@\\?#%\[\]]/.test(address) || (!ipv6 && !endsInNumber(address))) return null;
  try {
    // URL implements legacy IPv4 (decimal, octal, hex and shortened forms),
    // as well as IPv6 compression and dotted tails. Reject zone IDs above.
    const parsed = new URL(`http://${ipv6 ? `[${address}]` : address}/`).hostname;
    if (ipv6) return { address: normalizeNetworkHostname(parsed), family: 6 };
    return ipv4ToNumber(parsed) !== null ? { address: parsed, family: 4 } : null;
  } catch {
    return null;
  }
};

export const networkAddressFamily = (rawAddress: string): 4 | 6 | null => parseNetworkAddress(rawAddress)?.family ?? null;

export const isUnsafeNetworkAddress = (rawAddress: string): boolean => {
  const literal = parseNetworkAddress(rawAddress);
  if (!literal) return true;
  if (literal.family === 4) return UNSAFE_IPV4_RANGES.some(([base, bits]) => ipv4InRange(literal.address, base, bits));
  const value = ipv6ToBigInt(literal.address);
  if (value >> 32n === 0xffffn || ipv6InRange(value, ipv6ToBigInt("64:ff9b::"), 96)) {
    const mapped = Number(value & 0xffffffffn);
    return isUnsafeNetworkAddress([mapped >>> 24, (mapped >>> 16) & 255, (mapped >>> 8) & 255, mapped & 255].join("."));
  }
  return !ipv6InRange(value, ipv6ToBigInt("2000::"), 3) || UNSAFE_IPV6_RANGES.some(([base, bits]) => ipv6InRange(value, base, bits));
};

export const isUnsafeNetworkHostname = (rawHostname: string): boolean => {
  const hostname = normalizeNetworkHostname(rawHostname);
  return (
    !hostname ||
    ["localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data"].includes(hostname) ||
    [".localhost", ".internal", ".local", ".home.arpa"].some((suffix) => hostname.endsWith(suffix)) ||
    /[%\[\]]/.test(hostname) ||
    ((endsInNumber(hostname) || hostname.includes(":")) && !parseNetworkAddress(hostname))
  );
};

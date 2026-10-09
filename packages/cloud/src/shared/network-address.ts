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

const ipv6ToBigInt = (rawAddress: string): bigint | null => {
  let address = rawAddress.toLowerCase().split("%")[0] ?? "";
  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    const ipv4 = ipv4ToNumber(address.slice(separator + 1));
    if (separator < 0 || ipv4 === null) return null;
    address = `${address.slice(0, separator)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
};

const ipv6InRange = (address: bigint, base: bigint, bits: number): boolean => {
  const shift = BigInt(128 - bits);
  return address >> shift === base >> shift;
};

const UNSAFE_IPV6_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [ipv6ToBigInt("::")!, 96],
  [ipv6ToBigInt("64:ff9b::")!, 96],
  [ipv6ToBigInt("64:ff9b:1::")!, 48],
  [ipv6ToBigInt("100::")!, 64],
  [ipv6ToBigInt("2001::")!, 32],
  [ipv6ToBigInt("2001:2::")!, 48],
  [ipv6ToBigInt("2001:db8::")!, 32],
  [ipv6ToBigInt("2002::")!, 16],
  [ipv6ToBigInt("3fff::")!, 20],
  [ipv6ToBigInt("fc00::")!, 7],
  [ipv6ToBigInt("fe80::")!, 10],
  [ipv6ToBigInt("fec0::")!, 10],
  [ipv6ToBigInt("ff00::")!, 8],
];

export const normalizeNetworkHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export const networkAddressFamily = (rawAddress: string): 4 | 6 | null => {
  const address = normalizeNetworkHostname(rawAddress);
  if (ipv4ToNumber(address) !== null) return 4;
  return ipv6ToBigInt(address) !== null ? 6 : null;
};

export const isUnsafeNetworkAddress = (rawAddress: string): boolean => {
  const address = normalizeNetworkHostname(rawAddress);
  const family = networkAddressFamily(address);
  if (family === 4) return UNSAFE_IPV4_RANGES.some(([base, bits]) => ipv4InRange(address, base, bits));
  if (family !== 6) return true;
  const value = ipv6ToBigInt(address);
  if (value === null) return true;
  if (value >> 32n === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    const ipv4 = [mapped >>> 24, (mapped >>> 16) & 255, (mapped >>> 8) & 255, mapped & 255].join(".");
    return isUnsafeNetworkAddress(ipv4);
  }
  return UNSAFE_IPV6_RANGES.some(([base, bits]) => ipv6InRange(value, base, bits));
};

export const isUnsafeNetworkHostname = (rawHostname: string): boolean => {
  const hostname = normalizeNetworkHostname(rawHostname);
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal" || hostname.endsWith(".internal")
  );
};

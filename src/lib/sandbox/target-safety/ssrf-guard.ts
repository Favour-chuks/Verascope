import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export class UnsafeExternalUrlError extends Error {
  readonly code = "unsafe_target_url" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnsafeExternalUrlError";
  }
}

export type ExternalUrlSafetyResult = {
  url: URL;
  addresses: ResolvedAddress[];
};

const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isGloballyRoutableIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;

  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51) && (b !== 51 || c === 100)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(address: string): bigint | null {
  const lowered = address.toLowerCase();
  if (!lowered || lowered.includes("%")) return null;

  const dottedIndex = lowered.lastIndexOf(":");
  let expandedInput = lowered;
  if (dottedIndex >= 0 && lowered.includes(".")) {
    const mapped = ipv4Octets(lowered.slice(dottedIndex + 1));
    if (!mapped) return null;
    expandedInput = `${lowered.slice(0, dottedIndex)}:${((mapped[0] << 8) | mapped[1]).toString(16)}:${((mapped[2] << 8) | mapped[3]).toString(16)}`;
  }

  const halves = expandedInput.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value: bigint, prefix: bigint, bits: number): boolean {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (prefix & mask);
}

function isGloballyRoutableIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return false;

  if (value === 0n || value === 1n) return false;
  if (inIpv6Range(value, 0n, 96)) return false;
  if (inIpv6Range(value, 0xffffn << 32n, 96)) {
    const mapped = Number(value & 0xffffffffn);
    return isGloballyRoutableIpv4([mapped >>> 24, (mapped >>> 16) & 255, (mapped >>> 8) & 255, mapped & 255].join("."));
  }
  if (inIpv6Range(value, 0xfc00n << 112n, 7)) return false;
  if (inIpv6Range(value, 0xfe80n << 112n, 10)) return false;
  if (inIpv6Range(value, 0xff00n << 112n, 8)) return false;
  if (inIpv6Range(value, 0x20010db8n << 96n, 32)) return false;
  return true;
}

export function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isGloballyRoutableIpv4(address);
  if (family === 6) return isGloballyRoutableIpv6(address);
  return false;
}

export async function checkExternalUrl(input: string, resolver: HostResolver = defaultResolver): Promise<ExternalUrlSafetyResult> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeExternalUrlError("targetUrl must be a valid HTTP(S) URL.");
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new UnsafeExternalUrlError("targetUrl must be a credential-free HTTP(S) URL.");
  }

  const literalHost = url.hostname.replace(/^\[(.*)\]$/, "$1");
  let addresses: ResolvedAddress[];
  if (isIP(literalHost)) {
    addresses = [{ address: literalHost, family: isIP(literalHost) as 4 | 6 }];
  } else {
    try {
      addresses = await resolver(literalHost);
    } catch {
      throw new UnsafeExternalUrlError("targetUrl hostname could not be resolved safely.");
    }
  }

  if (!addresses.length || addresses.some(({ address }) => !isGloballyRoutableAddress(address))) {
    throw new UnsafeExternalUrlError("targetUrl resolves to a non-public address and cannot be scanned.");
  }

  return { url, addresses };
}

export async function isSafeExternalUrl(input: string, resolver: HostResolver = defaultResolver): Promise<boolean> {
  try {
    await checkExternalUrl(input, resolver);
    return true;
  } catch (error) {
    if (error instanceof UnsafeExternalUrlError) return false;
    throw error;
  }
}

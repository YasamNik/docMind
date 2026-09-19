import { createError } from "../../shared/errors/errors.js";

// Pure address and url rules for the telegram link fetch guard. No IO, no DNS: this
// module only ever looks at strings it is handed. The actual resolution happens in
// link-fetch.ts, which calls isPublicAddress on whatever a DNS lookup returns.

function linkRefused(message: string) {
  return createError({ code: "telegram.link_refused", message: `Link refused: ${message}`, status: 400 });
}

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw linkRefused(`"${raw}" is not a url`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw linkRefused(`the "${url.protocol}" scheme is not allowed, only http and https are`);
  }
  return url;
}

// Numeric range checks, not string prefixes, so a range like 10.0.0.0/8 never gets
// confused with an address that merely starts with the same digits, such as
// 100.64.0.1, which sits in the separate carrier grade NAT range instead.
function ipv4ToInt(ip: string): number | null {
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const value = Number(octet);
    if (value > 255) return null;
    result = (result << 8) | value;
  }
  return result >>> 0;
}

type Ipv4Range = { base: number; maskBits: number };

function ipv4Range(base: string, maskBits: number): Ipv4Range {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) throw new Error(`bad ipv4 range base "${base}"`);
  return { base: baseInt, maskBits };
}

function ipv4Mask(maskBits: number): number {
  return maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
}

function ipv4InRange(ipInt: number, range: Ipv4Range): boolean {
  const mask = ipv4Mask(range.maskBits);
  return (ipInt & mask) === (range.base & mask);
}

// Every non-globally-routable IPv4 block worth refusing, including 169.254.0.0/16,
// which carries the cloud metadata address every provider uses, and the carrier grade
// NAT range 100.64.0.0/10, which some providers use for the same purpose. 240.0.0.0/4
// also covers the broadcast address 255.255.255.255, so that needs no range of its own.
const BLOCKED_IPV4_RANGES: Ipv4Range[] = [
  ipv4Range("0.0.0.0", 8),
  ipv4Range("10.0.0.0", 8),
  ipv4Range("100.64.0.0", 10),
  ipv4Range("127.0.0.0", 8),
  ipv4Range("169.254.0.0", 16),
  ipv4Range("172.16.0.0", 12),
  ipv4Range("192.168.0.0", 16),
  ipv4Range("224.0.0.0", 4),
  ipv4Range("240.0.0.0", 4),
];

function isPublicIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  return !BLOCKED_IPV4_RANGES.some((range) => ipv4InRange(ipInt, range));
}

// Parses an IPv6 literal into its eight 16 bit groups, expanding "::" and any
// trailing embedded IPv4 tail such as the one in "::ffff:127.0.0.1", so the rest of
// this module only ever deals with plain numbers.
function parseIpv6Groups(ip: string): number[] | null {
  let address = ip;
  const embeddedIpv4 = address.includes(".");
  if (embeddedIpv4) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4Tail = address.slice(lastColon + 1);
    const ipv4Int = ipv4ToInt(ipv4Tail);
    if (ipv4Int === null) return null;
    const high = (ipv4Int >>> 16) & 0xffff;
    const low = ipv4Int & 0xffff;
    address = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const parts = address.split("::");
  if (parts.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const values: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      values.push(Number.parseInt(group, 16));
    }
    return values;
  };

  if (parts.length === 1) {
    const groups = parseGroups(parts[0]!);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseGroups(parts[0]!);
  const right = parseGroups(parts[1]!);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

// Unwraps an IPv4 address carried inside an IPv6 literal, in either shape: the current
// "mapped" form with an ffff marker, ::ffff:127.0.0.1, or the deprecated "compatible"
// form with no marker at all, ::127.0.0.1. Both put the same four bytes in the same
// place, so both need to be checked as the IPv4 address they actually are, including
// the all-zero cases this also catches: the unspecified address "::" and loopback
// "::1" unwrap to 0.0.0.0 and 0.0.0.1, both already blocked as part of 0.0.0.0/8.
function embeddedIpv4Address(groups: number[]): string | null {
  const topZero = groups.slice(0, 5).every((group) => group === 0);
  if (!topZero) return null;
  const marker = groups[5]!;
  if (marker !== 0 && marker !== 0xffff) return null;
  const high = groups[6]!;
  const low = groups[7]!;
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join(".");
}

function isPublicIpv6(groups: number[]): boolean {
  const first = groups[0]!;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  if (isUniqueLocal) return false;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  if (isLinkLocal) return false;
  const isMulticast = (first & 0xff00) === 0xff00;
  if (isMulticast) return false;
  return true;
}

export function isPublicAddress(ip: string): boolean {
  if (!ip.includes(":")) return isPublicIpv4(ip);

  const groups = parseIpv6Groups(ip);
  if (!groups) return false;

  const embeddedIpv4 = embeddedIpv4Address(groups);
  if (embeddedIpv4) return isPublicIpv4(embeddedIpv4);

  return isPublicIpv6(groups);
}

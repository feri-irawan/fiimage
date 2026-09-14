import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class UnsafeHttpUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeHttpUrlError";
  }
}

const blockedNetworks = new BlockList();

for (const [subnet, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::", 96, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["2001::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
] as const) {
  blockedNetworks.addSubnet(subnet, prefix, type);
}

const normalizeHostname = (hostname: string) =>
  hostname.replace(/^\[|\]$/g, "").toLowerCase();

const parseIpv6Parts = (part: string) => {
    if (!part) return [];
    const pieces = part.split(":");
    const last = pieces[pieces.length - 1];
    if (last?.includes(".")) {
      const octets = last.split(".").map(Number);
      if (
        octets.length !== 4 ||
        octets.some(
          (octet) =>
            !Number.isInteger(octet) || octet < 0 || octet > 255
        )
      ) {
        return;
      }
      pieces.splice(
        -1,
        1,
        ((octets[0] << 8) | octets[1]).toString(16),
        ((octets[2] << 8) | octets[3]).toString(16)
      );
    }
    if (pieces.some((piece) => !/^[\da-f]{1,4}$/i.test(piece))) return;
    return pieces.map((piece) => Number.parseInt(piece, 16));
};

const expandIpv6 = (address: string): number[] | undefined => {
  if (!address.includes("::")) {
    const parts = parseIpv6Parts(address);
    return parts?.length === 8 ? parts : undefined;
  }

  const [head, tail, ...extra] = address.split("::");
  if (extra.length > 0) return;

  const headParts = parseIpv6Parts(head);
  const tailParts = parseIpv6Parts(tail);
  if (!headParts || !tailParts) return;
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 1) return;
  return [...headParts, ...Array.from({ length: missing }, () => 0), ...tailParts];
};

const getMappedIpv4 = (ip: string) => {
  const hextets = expandIpv6(ip);
  if (!hextets || hextets.length !== 8) return;
  if (!hextets.slice(0, 5).every((hextet) => hextet === 0) || hextets[5] !== 0xffff) return;

  return `${hextets[6] >> 8}.${hextets[6] & 255}.${hextets[7] >> 8}.${hextets[7] & 255}`;
};

const isBlockedAddress = (address: string): boolean => {
  const ip = normalizeHostname(address);

  // IPv4-mapped IPv6 addresses can otherwise bypass IPv4 checks. URL parsing
  // may normalize them to hexadecimal, so expand all valid IPv6 spellings.
  const mappedIpv4 = getMappedIpv4(ip);
  if (mappedIpv4) {
    return isBlockedAddress(mappedIpv4);
  }

  const family = isIP(ip);
  if (family === 4) return blockedNetworks.check(ip, "ipv4");
  if (family === 6) return blockedNetworks.check(ip, "ipv6");
  return true;
};

type SafeUrlOptions = {
  timeoutMs?: number;
};

/** Reject URLs that resolve to local, private, or otherwise non-public networks. */
export const assertSafeHttpUrl = async (
  rawUrl: string,
  { timeoutMs = 5_000 }: SafeUrlOptions = {}
) => {
  const url = new URL(rawUrl);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new UnsafeHttpUrlError("Only public HTTP(S) URLs are allowed.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new UnsafeHttpUrlError("Private network URLs are not allowed.");
  }

  const literal = isIP(hostname);
  let addresses: Array<{ address: string }>;
  try {
    if (literal) {
      addresses = [{ address: hostname }];
    } else {
      const lookupPromise = lookup(hostname, { all: true, verbatim: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        addresses = await Promise.race([
          lookupPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("DNS lookup timed out.")),
              Math.max(1, timeoutMs)
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch {
    throw new UnsafeHttpUrlError("Unable to resolve a public HTTP(S) URL.");
  }

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new UnsafeHttpUrlError("Private network URLs are not allowed.");
  }

  return url;
};

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { FetchError } from "./fetcher.ts";

/**
 * Addresses `web_fetch` may not reach: this machine, private and shared networks, link-local (cloud metadata at
 * 169.254.169.254), and the ranges that are not on the public internet. IPv4 inside IPv6 (`::ffff:10.0.0.1`) is caught
 * by the same IPv4 rules. Decided in R036, before groups got the tool (docs/design/2026-10-05-web-fetch.md §3.3).
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

/** Whether an IP address is on the public internet, as far as `web_fetch` is concerned. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type ResolveHost = (host: string) => Promise<readonly string[]>;

const resolveHost: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Throws `blocked_address` unless every address the URL's host stands for is public; a name that does not resolve is a
 * `network` error, as the request would have been. Checked for every hop of a redirect chain. The request itself
 * resolves the name again, so a name whose answer changes in between (DNS rebinding) is not caught; accepted (§3.3).
 */
export async function checkAddress(url: URL, resolve: ResolveHost = resolveHost): Promise<void> {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: readonly string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new FetchError("network", `could not find the address of ${url.host}`);
    }
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new FetchError("blocked_address", `${url.host} is a local or private network address`);
  }
}

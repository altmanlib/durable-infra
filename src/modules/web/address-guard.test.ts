import { expect, test } from "bun:test";
import { checkAddress, isPublicAddress } from "./address-guard.ts";
import { FetchError } from "./fetcher.ts";

test("this machine, private, shared and link-local networks are not public; the internet is", () => {
  const blocked = [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "not an address",
  ];
  for (const address of blocked) expect([address, isPublicAddress(address)]).toEqual([address, false]);
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])
    expect([address, isPublicAddress(address)]).toEqual([address, true]);
});

async function kindOf(url: string, resolve: (host: string) => Promise<readonly string[]>): Promise<string | undefined> {
  try {
    await checkAddress(new URL(url), resolve);
    return undefined;
  } catch (error) {
    return error instanceof FetchError ? error.kind : "other";
  }
}

test("a name is checked by every address it stands for, and one that does not resolve is a network error", async () => {
  const resolve = async (host: string): Promise<readonly string[]> => {
    if (host === "public.test") return ["93.184.216.34", "2606:2800:220:1::1"];
    if (host === "mixed.test") return ["93.184.216.34", "10.0.0.5"];
    if (host === "localhost") return ["127.0.0.1", "::1"];
    throw new Error("ENOTFOUND");
  };
  expect(await kindOf("https://public.test/a", resolve)).toBeUndefined();
  expect(await kindOf("https://mixed.test/a", resolve)).toBe("blocked_address");
  expect(await kindOf("http://localhost:29433/api/health", resolve)).toBe("blocked_address");
  expect(await kindOf("http://[fd00::1]/", resolve)).toBe("blocked_address");
  expect(await kindOf("http://169.254.169.254/", resolve)).toBe("blocked_address");
  expect(await kindOf("https://missing.test/", resolve)).toBe("network");
});

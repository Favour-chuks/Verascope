import assert from "node:assert/strict";
import {
  checkExternalUrl,
  isGloballyRoutableAddress,
  isSafeExternalUrl,
  type HostResolver,
} from "@/lib/sandbox/target-safety/ssrf-guard";

let assertions = 0;
const verify = (condition: unknown, message: string) => {
  assertions += 1;
  assert.ok(condition, message);
};

const resolverFor = (...addresses: string[]): HostResolver => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const unsafe = [
  "127.0.0.1", "10.23.1.4", "172.16.0.1", "172.31.255.255", "192.168.1.1",
  "169.254.169.254", "169.254.20.4", "0.0.0.0", "100.64.0.1", "198.18.0.1",
  "198.51.100.7", "203.0.113.7", "224.0.0.1", "255.255.255.255",
  "::", "::1", "fc00::1", "fd12::4", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1",
];

for (const address of unsafe) verify(!isGloballyRoutableAddress(address), `unsafe address was allowed: ${address}`);
for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
  verify(isGloballyRoutableAddress(address), `global address was rejected: ${address}`);
}

const publicResult = await checkExternalUrl("https://public.example/path", resolverFor("93.184.216.34"));
verify(publicResult.url.hostname === "public.example", "public HTTP target was not accepted");
verify(!(await isSafeExternalUrl("not a URL", resolverFor("93.184.216.34"))), "malformed URL was accepted");
verify(!(await isSafeExternalUrl("ftp://public.example", resolverFor("93.184.216.34"))), "non-HTTP URL was accepted");
verify(!(await isSafeExternalUrl("https://user:pass@public.example", resolverFor("93.184.216.34"))), "credential-bearing URL was accepted");
verify(!(await isSafeExternalUrl("https://mixed.example", resolverFor("93.184.216.34", "10.0.0.1"))), "mixed DNS answer was accepted");

const failingResolver: HostResolver = async () => { throw new Error("DNS unavailable"); };
verify(!(await isSafeExternalUrl("https://unresolved.example", failingResolver)), "resolver failure was accepted");

let call = 0;
const rebindingResolver: HostResolver = async () => {
  call += 1;
  return [{ address: call === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 }];
};
verify(await isSafeExternalUrl("https://rebind.example", rebindingResolver), "initial public DNS answer was rejected");
verify(!(await isSafeExternalUrl("https://rebind.example", rebindingResolver)), "pre-fetch DNS re-check reused approval");
verify(call === 2, "resolver was not called independently for the second check");

console.log(`SSRF guard verification passed: ${assertions} assertions across IPv4, IPv6, DNS, and rebinding cases.`);

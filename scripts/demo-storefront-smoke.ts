import { once } from "node:events";
import { createDemoStorefront } from "@/lib/demo-storefront/server";

const server = createDemoStorefront();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo storefront did not bind a local port.");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const [home, privacy, override] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/privacy`),
    fetch(`${baseUrl}/api/attribution/override`, { method: "POST" }),
  ]);
  const policy = await privacy.text();
  const setCookie = override.headers.get("set-cookie") ?? "";

  if (!home.ok || !policy.includes("preserve an existing affiliate") || !setCookie.includes("affiliate_ref=alder-row-override-token")) {
    throw new Error("Demo storefront fixture did not expose the required runtime-test contract.");
  }

  console.log(`Demo storefront smoke test passed at ${baseUrl}`);
} finally {
  server.close();
  await once(server, "close");
}

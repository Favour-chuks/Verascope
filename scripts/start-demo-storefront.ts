import { DEMO_STOREFRONT_PORT, startDemoStorefront } from "@/lib/demo-storefront/server";

const requestedPort = process.env.DEMO_STOREFRONT_PORT ? Number(process.env.DEMO_STOREFRONT_PORT) : DEMO_STOREFRONT_PORT;
const server = await startDemoStorefront(requestedPort);

console.log(`Alder & Row demo storefront listening on http://127.0.0.1:${requestedPort}`);

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

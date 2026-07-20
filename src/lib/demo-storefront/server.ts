import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const DEMO_STOREFRONT_PORT = 3100;

const privacyPolicy = `<!doctype html>
<html lang="en"><head><title>Alder & Row Privacy</title></head><body>
<main>
  <h1>Privacy at Alder & Row</h1>
  <p id="attribution-policy">We preserve an existing affiliate or referral attribution unless you explicitly select an Alder & Row referral or promotional control.</p>
  <p id="analytics-policy">We begin analytics collection only after you accept optional cookies.</p>
  <p id="checkout-policy">We use checkout events only to complete the current shopping session.</p>
</main>
</body></html>`;

const homePage = `<!doctype html>
<html lang="en"><head><title>Alder & Row</title></head><body>
<main>
  <h1>Alder & Row</h1>
  <p>A synthetic storefront used only for Verascope runtime verification.</p>
  <a href="/checkout?affiliate_ref=verascope-upstream-token">Proceed to checkout</a>
  <button id="accept-consent" type="button">Accept optional cookies</button>
  <button id="decline-consent" type="button">Decline optional cookies</button>
  <a href="/privacy">Privacy</a>
</main>
<script>
  fetch('/api/analytics?event=page_view&consent=unset', { method: 'POST', keepalive: true });
  document.getElementById('accept-consent').addEventListener('click', () => fetch('/api/analytics?event=consent_accept&consent=accepted', { method: 'POST' }));
  document.getElementById('decline-consent').addEventListener('click', () => fetch('/api/analytics?event=consent_decline&consent=declined', { method: 'POST' }));
</script>
</body></html>`;

const checkoutPage = `<!doctype html>
<html lang="en"><head><title>Alder & Row Checkout</title></head><body>
<main>
  <h1>Checkout</h1>
  <p>Demo checkout. No payment information is collected.</p>
  <button id="place-demo-order" type="button">Place synthetic order</button>
</main>
<script>
  const params = new URLSearchParams(window.location.search);
  const upstream = params.get('affiliate_ref');
  if (upstream) document.cookie = 'affiliate_ref=' + encodeURIComponent(upstream) + '; Path=/; SameSite=Lax';
  fetch('/api/attribution/override', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow: 'checkout', attribution_key: 'affiliate_ref' })
  });
</script>
</body></html>`;

function writeHtml(response: ServerResponse, body: string, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function writeJson(response: ServerResponse, body: object, headers: Record<string, string> = {}, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/") return writeHtml(response, homePage);
  if (request.method === "GET" && url.pathname === "/checkout") return writeHtml(response, checkoutPage);
  if (request.method === "GET" && url.pathname === "/privacy") return writeHtml(response, privacyPolicy);
  if (request.method === "POST" && url.pathname === "/api/analytics") {
    return writeJson(response, { accepted: true, payload_shape: ["event", "consent"], synthetic: true });
  }
  if (request.method === "POST" && url.pathname === "/api/attribution/override") {
    return writeJson(
      response,
      { accepted: true, payload_shape: ["flow", "attribution_key"], synthetic: true },
      { "set-cookie": "affiliate_ref=alder-row-override-token; Path=/; SameSite=Lax" },
    );
  }
  return writeJson(response, { error: "not_found" }, {}, 404);
}

export function createDemoStorefront(): Server {
  return createServer(route);
}

export async function startDemoStorefront(port = DEMO_STOREFRONT_PORT): Promise<Server> {
  const server = createDemoStorefront();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

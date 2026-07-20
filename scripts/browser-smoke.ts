import { chromium } from "playwright";

async function verify(name: string, launch: () => ReturnType<typeof chromium.launch>) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>Verascope browser smoke</title>");
    if (await page.title() !== "Verascope browser smoke") throw new Error("Unexpected smoke page title.");
    console.log(`${name}: launch passed`);
  } finally {
    await browser.close();
  }
}

const bundledExecutablePath = process.env.PLAYWRIGHT_BUNDLED_CHROMIUM_PATH;

await verify("Playwright bundled Chromium", () => chromium.launch({
  headless: true,
  ...(bundledExecutablePath ? { executablePath: bundledExecutablePath } : {}),
}));
await verify("Playwright real Chrome channel", () => chromium.launch({ channel: "chrome", headless: true }));

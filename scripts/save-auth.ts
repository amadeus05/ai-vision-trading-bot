import { chromium } from "playwright";
import * as fs from "fs";
import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const AUTH_FILE = "auth.json";
const START_URL = "https://www.coinglass.com/";
const LEGEND_URL = "https://legend.coinglass.com/chart/aa93c95027c84880b0dc1911c13f176e";

async function main() {
    console.log("Opening browser for CoinGlass login...");

    const browser = await chromium.launch({
        headless: false,
        slowMo: 80,
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    const rl = readline.createInterface({ input, output });

    console.log("");
    console.log("1. Log in to CoinGlass in the opened browser.");
    console.log("2. Open CoinGlass Legend and make sure the chart is visible.");
    console.log("3. Return here and press Enter.");
    console.log("");
    console.log(`Legend URL: ${LEGEND_URL}`);
    console.log("");

    await rl.question("Press Enter after successful login...");
    rl.close();

    await page.goto(LEGEND_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => undefined);
    await page.waitForTimeout(3000);

    await context.storageState({ path: AUTH_FILE });

    const stat = fs.statSync(AUTH_FILE);
    console.log(`Saved fresh session to ${AUTH_FILE} (${stat.size} bytes).`);

    await browser.close();
}

main().catch((error) => {
    console.error("Failed to save CoinGlass auth:", error);
    process.exit(1);
});

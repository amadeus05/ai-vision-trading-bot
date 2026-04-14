import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import chalk from "chalk";
import { CONFIG, SymbolConfig } from "./config";
import { logEvent } from "./structuredLogger";

export class CoinglassClient {
    private browser: Browser | null = null;

    constructor(private readonly config = CONFIG) {}

async captureLegend(symbolConfig: SymbolConfig): Promise<{ pathEntry: string, pathContext: string }> {
    const { symbol, coinSymbol, exchange, legendUrl } = symbolConfig;
    const { debug, slowMo } = this.config.browser;
    const startedAt = Date.now();

    logEvent({
        symbol,
        phase: "capture_legend",
        status: "start",
        meta: { coinSymbol, exchange, entryTf: this.config.timeframes.entryTf, contextTf: this.config.timeframes.contextTf },
    });

    // Закрываем старый браузер если был
    if (this.browser) {
        await this.browser.close();
        this.browser = null;
    }

    // Запускаем с учётом настроек debug
    console.log(chalk.blue(`🚀 Запуск браузера (debug: ${debug}, slowMo: ${slowMo}ms)...`));
    this.browser = await chromium.launch({
        headless: !debug,
        slowMo: debug ? slowMo : 0
    });

    const storageState = fs.existsSync("auth.json") ? "auth.json" : undefined;
    const context = await this.browser.newContext({
        storageState,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 }
    });

    const page = await context.newPage();

    try {
        console.log(chalk.blue("🌐 Прогрев куки на основном домене..."));
        // await page.goto("https://www.coinglass.com/", { waitUntil: "domcontentloaded" });
        // await page.waitForTimeout(3000);

        console.log(chalk.blue(`🚀 Переход на Legend: ${legendUrl}`));
        await page.goto(legendUrl, { waitUntil: "networkidle", timeout: 90000 });

        console.log(chalk.gray("🔍 Уменьшаю масштаб страницы..."));
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press("Control+-");
        }
        await page.waitForTimeout(2000);

        // ==== ПЕРЕКЛЮЧЕНИЕ МОНЕТЫ ====
        await this.switchCoin(page, coinSymbol, exchange);

        // ==== ПРОВЕРКА И ВКЛЮЧЕНИЕ ОСНОВНОГО ТАЙМФРЕЙМА ====
        const { entryTf, contextTf } = this.config.timeframes;

        const activeEntry = await page.$(`div.b-h.act:has-text("${entryTf}")`);
        if (!activeEntry) {
            console.log(chalk.yellow(`⚠️ ${entryTf} не активен, переключаем...`));
            await page.click(`div.b-h:has-text("${entryTf}")`);
            await page.waitForTimeout(10000); // Ждем прогрузки
        } else {
            console.log(chalk.green(`✅ ${entryTf} уже активен.`));
        }

        console.log(chalk.yellow(`⏳ Ожидание отрисовки ${entryTf} (10 сек)...`));
        await page.waitForTimeout(10000);

        const pathEntry = `./screenshots/${symbol.toLowerCase()}_${entryTf.toLowerCase()}.png`;
        if (!fs.existsSync("./screenshots")) fs.mkdirSync("./screenshots");
        await this.removeChartPanes(page);
        const entryScreenshotStartedAt = Date.now();
        await page.screenshot({ path: pathEntry, fullPage: false });
        logEvent({
            symbol,
            phase: "screenshot_entry",
            status: "success",
            duration_ms: Date.now() - entryScreenshotStartedAt,
            screenshot_path: pathEntry,
            selector_used: `div.b-h:has-text("${entryTf}")`,
        });
        console.log(chalk.green(`📸 Скриншот ${entryTf} успешно сделан!`));

        // ==== ПЕРЕКЛЮЧЕНИЕ НА СТАРШИЙ ТАЙМФРЕЙМ ====
        console.log(chalk.blue(`📅 Переключение на ${contextTf}...`));
        const activeContext = await page.$(`div.b-h.act:has-text("${contextTf}")`);
        if (!activeContext) {
            await page.click(`div.b-h:has-text("${contextTf}")`);
            await page.waitForTimeout(15000); // Ждем прогрузки
        }
        const pathContext = `./screenshots/${symbol.toLowerCase()}_${contextTf.toLowerCase()}.png`;
        await this.removeChartPanes(page);
        const contextScreenshotStartedAt = Date.now();
        await page.screenshot({ path: pathContext, fullPage: false });
        logEvent({
            symbol,
            phase: "screenshot_context",
            status: "success",
            duration_ms: Date.now() - contextScreenshotStartedAt,
            screenshot_path: pathContext,
            selector_used: `div.b-h:has-text("${contextTf}")`,
        });
        console.log(chalk.green(`📸 Скриншот ${contextTf} успешно сделан!`));

        logEvent({
            symbol,
            phase: "capture_legend",
            status: "success",
            duration_ms: Date.now() - startedAt,
            screenshot_path: `${pathEntry},${pathContext}`,
            meta: { coinSymbol, exchange },
        });

        return { pathEntry, pathContext };
    } catch (error: any) {
        logEvent({
            symbol,
            phase: "capture_legend",
            status: "failure",
            duration_ms: Date.now() - startedAt,
            error: error?.message || String(error),
            meta: { coinSymbol, exchange, legendUrl },
        });
        throw error;
    } finally {
        await page.close();
        await context.close();
    }
}

private async removeChartPanes(page: Page): Promise<void> {
    const removedCount = await page.evaluate(() => {
        const panes = Array.from(document.querySelectorAll('[id="candle_pane"], [id^="indicator_pane__"]'));
        const legendChart = document.querySelector("#legend_chart_1");
        const legendChartSiblings = legendChart?.parentElement
            ? Array.from(legendChart.parentElement.children).filter((element) => element !== legendChart)
            : [];

        panes.push(...legendChartSiblings);

        const uniquePanes = Array.from(new Set(panes));
        uniquePanes.forEach((pane) => pane.remove());
        return uniquePanes.length;
    });

    console.log(chalk.gray(`   -> Removed chart DOM panes: ${removedCount}`));
}

/**
 * Переключает монету через модальное окно поиска
 */
private async switchCoin(page: Page, coinSymbol: string, exchange: string): Promise<void> {
    const startedAt = Date.now();
    const selectorUsed = `div.dialog-list-item has text="${exchange}"`;
    logEvent({
        symbol: coinSymbol,
        phase: "switch_coin",
        status: "start",
        selector_used: selectorUsed,
        meta: { exchange },
    });
    console.log(chalk.cyan(`🔍 Переключение на ${coinSymbol} (${exchange})...`));

    // 1. Нажимаем на иконку поиска
    console.log(chalk.gray("   → Открываю модалку поиска..."));
    const searchInput = page.locator('input[placeholder="Search"]').first();

    if (!(await searchInput.isVisible().catch(() => false))) {
        const searchOpeners = [
            page.locator('button[aria-label="Search Trading Pairs"]').first(),
            page.locator('[aria-label*="Search" i]').first(),
            page.locator('[title*="Search" i]').first(),
        ];

        let opened = false;
        for (const opener of searchOpeners) {
            if (await opener.isVisible().catch(() => false)) {
                await opener.click({ timeout: 3000 })
                    .catch(async () => opener.click({ timeout: 3000, force: true }))
                    .catch(async () => opener.evaluate((element: HTMLElement) => element.click()));
                opened = await searchInput.waitFor({ state: 'visible', timeout: 3000 })
                    .then(() => true)
                    .catch(() => false);
                if (opened) break;
            }
        }

        if (!opened) {
            // CoinGlass periodically changes MUI classes/ARIA labels. The magnifier is
            // consistently in the top toolbar around this coordinate on the 1920px viewport.
            await page.mouse.click(440, 30);
            opened = await searchInput.waitFor({ state: 'visible', timeout: 5000 })
                .then(() => true)
                .catch(() => false);
        }

        if (!opened) {
            const visibleTopButtons = await page.locator('button, [role="button"], [aria-label], [title]')
                .evaluateAll(elements => elements.slice(0, 20).map((element) => ({
                    tag: element.tagName,
                    text: element.textContent?.trim().slice(0, 80),
                    aria: element.getAttribute('aria-label'),
                    title: element.getAttribute('title'),
                })))
                .catch(() => []);
            console.log(chalk.red("   Search modal was not opened. Visible button-like elements:"), visibleTopButtons);
            throw new Error("CoinGlass search modal was not opened");
        }
    }

    // 2. Ждём появления модалки и инпута
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });

    // 3. Очищаем инпут и вводим символ монеты
    console.log(chalk.gray(`   → Ввожу "${coinSymbol}"...`));
    await searchInput.clear();
    await searchInput.fill(coinSymbol);
    await page.waitForTimeout(1500); // Ждём загрузки результатов

    // 4. Ищем в списке нужную монету на нужной бирже
    console.log(chalk.gray(`   → Ищу ${coinSymbol} на бирже ${exchange}...`));

    // Ищем строку в списке, где есть нужная биржа
    const listItem = page.locator('div.dialog-list-item').filter({
        has: page.locator(`text="${exchange}"`)
    }).first();

    // Проверяем что нашли
    const itemCount = await listItem.count();
    if (itemCount === 0) {
        console.log(chalk.red(`   ❌ Не найден ${coinSymbol} на ${exchange}!`));
        // Закрываем модалку
        await page.keyboard.press('Escape');
        throw new Error(`Монета ${coinSymbol} на бирже ${exchange} не найдена`);
    }

    // 5. Кликаем на найденный элемент
    console.log(chalk.gray(`   → Выбираю ${coinSymbol} на ${exchange}...`));
    await listItem.click();

    // Ждём загрузки нового графика
    console.log(chalk.yellow(`   ⏳ Ожидание загрузки графика ${coinSymbol}...`));
    await page.waitForTimeout(5000);

    console.log(chalk.green(`   ✅ Монета ${coinSymbol} (${exchange}) успешно выбрана!`));
    logEvent({
        symbol: coinSymbol,
        phase: "switch_coin",
        status: "success",
        duration_ms: Date.now() - startedAt,
        selector_used: selectorUsed,
        meta: { exchange },
    });
}
}

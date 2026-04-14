import { chromium, Browser, Page } from "playwright";
import { Telegraf, Input } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import chalk from "chalk";
import { AiResponse, parseAndValidateAiResponse, formatAiResponseForTelegram } from "./schemas/aiResponse";
import WebSocket from "ws";
import { ImageProcessor } from "./imageProcessor";
import { getSystemPrompt } from "./prompts";
import { logEvent } from "./structuredLogger";

dotenv.config();

// ===================== CONFIG =====================

// Доступные таймфреймы CoinGlass
enum Timeframe {
    M1 = "1m",
    M3 = "3m",
    M5 = "5m",
    M15 = "15m",
    M30 = "30m",
    H1 = "1H",
    H2 = "2H",
    H4 = "4H",
    H6 = "6H",
    H8 = "8H",
    H12 = "12H",
    D1 = "1D",
    W1 = "1W",
}

interface TimeframeConfig {
    entryTf: Timeframe;    // основной (младший) - точка входа
    contextTf: Timeframe;  // старший (контекст рынка)
}

interface SymbolConfig {
    symbol: string;      // Название монеты для отображения (например, "ETHUSDT")
    coinSymbol: string;  // Символ для поиска в CoinGlass (например, "ETH")
    exchange: string;    // Биржа (например, "Bybit")
    legendUrl: string;
    isActive: boolean;
}

const CONFIG = {
    gemini: [
        { key: "key1", apiKey: process.env.GEMINI_API_KEY_1 || "" },
        { key: "key2", apiKey: process.env.GEMINI_API_KEY_2 || "" },
        { key: "key3", apiKey: process.env.GEMINI_API_KEY_3 || "" },
        { key: "key4", apiKey: process.env.GEMINI_API_KEY_4 || "" },
        { key: "key5", apiKey: process.env.GEMINI_API_KEY_5 || "" },
        { key: "key6", apiKey: process.env.GEMINI_API_KEY_6 || "" },
        { key: "key7", apiKey: process.env.GEMINI_API_KEY_7 || "" },
    ],
    tgToken: process.env.TELEGRAM_BOT_TOKEN || "",
    tgChatId: process.env.TELEGRAM_CHAT_ID || "",

    // ========== НАСТРОЙКИ БРАУЗЕРА И ДЕБАГА ==========
    browser: {
        debug: false,      // true = показывать браузер (headless: false), false = скрытый режим
        slowMo: 100,       // Задержка между действиями в мс (для дебага, 0 = без задержки)
    },

    // ========== НАСТРОЙКИ ТАЙМФРЕЙМОВ ==========
    timeframes: {
        entryTf: Timeframe.M15,    // основной (младший) - точка входа
        contextTf: Timeframe.H1,  // старший (контекст рынка)
    } as TimeframeConfig,

    symbols: [
        {
            symbol: "ETHUSDT",           // Отображаемое название
            coinSymbol: "ETH",           // Символ для поиска в CoinGlass
            exchange: "Bybit",           // Биржа
            legendUrl: "https://legend.coinglass.com/chart/aa93c95027c84880b0dc1911c13f176e",
            isActive: true,
        },
        {
            symbol: "SUIUSDT",           // Отображаемое название
            coinSymbol: "SUI",           // Символ для поиска в CoinGlass
            exchange: "Bybit",           // Биржа
            legendUrl: "https://legend.coinglass.com/chart/aa93c95027c84880b0dc1911c13f176e",
            isActive: true,
        },
        {
            symbol: "BTCUSDT",           // Отображаемое название
            coinSymbol: "BTC",           // Символ для поиска в CoinGlass
            exchange: "Bybit",           // Биржа
            legendUrl: "https://legend.coinglass.com/chart/aa93c95027c84880b0dc1911c13f176e",
            isActive: true,
        },
    ] as SymbolConfig[],
    kline: Timeframe.M15, // Binance kline для шедуллера (например, 15m, 1h, 4h)
    runInitialAnalysis: true, // Провести анализ сразу при запуске (true) или ждать закрытия первой свечи (false)
    workingHours: {
        start: "10:00",
        end: "22:00",
        timezone: "Europe/Kiev"
    }
};

const STATE_FILE = "./trade_state.json";
const KEYS_USAGE_FILE = "./keys_usage.json";
const WAIT_NOTIFICATIONS_FILE = "./wait_notifications.json";

// ===================== TYPES =====================
interface KeyUsage {
    key: string;
    symbol: string;
    start: string;
    usages: number;
    isExceeded?: boolean;
}

interface WaitNotificationState {
    waitType: AiResponse["executionPlan"]["waitType"];
    liquidityInteraction: AiResponse["lowerTimeframe"]["liquidityInteraction"];
    activationTrigger: string;
}

// ===================== BOT =====================
class QuantBot {
    private tgBot: Telegraf;
    private browser: Browser | null = null;
    private tradeState: any = { active: false, side: null };
    private keysUsage: KeyUsage[] = [];
    private lastWaitNotifications: Record<string, WaitNotificationState> = {};
    private imageProcessor: ImageProcessor;

    constructor() {
        this.imageProcessor = new ImageProcessor();
        if (!CONFIG.tgToken) {
            console.error(chalk.red("❌ Ошибка: Проверьте TELEGRAM_BOT_TOKEN в .env"));
            process.exit(1);
        }

        // Проверка наличия хотя бы одного ключа
        const validKeys = CONFIG.gemini.filter(k => k.apiKey);
        if (validKeys.length === 0) {
            console.error(chalk.red("❌ Ошибка: Нет ни одного валидного GEMINI_API_KEY"));
            process.exit(1);
        }

        this.tgBot = new Telegraf(CONFIG.tgToken);
        this.loadState();
        this.loadKeysUsage();
        this.loadWaitNotifications();
        this.checkAndResetKeys();
    }

    private loadState() {
        if (fs.existsSync(STATE_FILE)) {
            try {
                this.tradeState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
            } catch (e) {
                this.tradeState = { active: false, side: null };
            }
        }
    }

    private loadKeysUsage() {
        if (fs.existsSync(KEYS_USAGE_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(KEYS_USAGE_FILE, "utf-8"));
                // Ensure data is an array, otherwise reset to empty array
                this.keysUsage = Array.isArray(data) ? data : [];
            } catch (e) {
                this.keysUsage = [];
            }
        }
    }

    private saveKeysUsage() {
        fs.writeFileSync(KEYS_USAGE_FILE, JSON.stringify(this.keysUsage, null, 2));
    }

    private loadWaitNotifications() {
        if (fs.existsSync(WAIT_NOTIFICATIONS_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(WAIT_NOTIFICATIONS_FILE, "utf-8"));
                this.lastWaitNotifications = data && typeof data === "object" && !Array.isArray(data) ? data : {};
            } catch (e) {
                this.lastWaitNotifications = {};
            }
        }
    }

    private saveWaitNotifications() {
        fs.writeFileSync(WAIT_NOTIFICATIONS_FILE, JSON.stringify(this.lastWaitNotifications, null, 2));
    }

    private checkAndResetKeys() {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Проверяем, есть ли записи из прошлых дней
        const hasOldEntries = this.keysUsage.some(usage => {
            const usageDate = usage.start.split(' ')[0];
            return usageDate !== today;
        });

        if (hasOldEntries) {
            console.log(chalk.magenta.bold(`📅 Наступил новый день (${today})! Сбрасываю все лимиты ключей...`));
            this.keysUsage = [];
            this.saveKeysUsage();
            return;
        }

        // Получаем список активных символов
        const activeSymbols = CONFIG.symbols.filter(s => s.isActive).map(s => s.symbol);
        const originalCount = this.keysUsage.length;

        // Удаляем записи для символов, которые больше не активны
        this.keysUsage = this.keysUsage.filter(usage => {
            const isActiveSymbol = activeSymbols.includes(usage.symbol);
            if (!isActiveSymbol) {
                console.log(chalk.yellow(`🔓 Освобождение ключа ${usage.key} от неактивного символа ${usage.symbol}`));
                return false;
            }
            return true;
        });

        if (this.keysUsage.length !== originalCount) {
            this.saveKeysUsage();
        }

        console.log(chalk.blue(`🔄 Проверка ключей выполнена. Актуальных записей: ${this.keysUsage.length}`));
    }

    private getAvailableKeyForSymbol(symbol: string): { key: string; apiKey: string } | null {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // 1. Проверяем список ключей, которые УЖЕ превысили лимит сегодня (глобально)
        const exceededKeys = this.keysUsage
            .filter(usage => usage.start.startsWith(today) && usage.isExceeded)
            .map(usage => usage.key);

        // 2. Проверяем, есть ли уже зарезервированный ключ для этого символа сегодня, который НЕ превысил лимит
        const existing = this.keysUsage.find(
            usage => usage.symbol === symbol && usage.start.startsWith(today) && !usage.isExceeded
        );

        if (existing) {
            const keyConfig = CONFIG.gemini.find(k => k.key === existing.key);
            if (keyConfig && keyConfig.apiKey) {
                console.log(chalk.green(`✅ Используем зарезервированный ключ ${existing.key} для ${symbol}`));
                return { key: existing.key, apiKey: keyConfig.apiKey };
            }
        }

        // 3. Находим ключи, которые уже заняты другими символами сегодня ИЛИ уже превысили лимит
        const unavailableKeys = this.keysUsage
            .filter(usage => usage.start.startsWith(today) && (usage.symbol !== symbol || usage.isExceeded))
            .map(usage => usage.key);

        // 4. Ищем свободный ключ, который НЕ в списке занятых/исчерпанных
        const availableKey = CONFIG.gemini.find(
            k => k.apiKey && !unavailableKeys.includes(k.key)
        );

        if (availableKey) {
            console.log(chalk.yellow(`🔑 Резервирую новый ключ ${availableKey.key} для ${symbol}`));
            const usage: KeyUsage = {
                key: availableKey.key,
                symbol: symbol,
                start: now.toISOString().replace('T', ' ').split('.')[0],
                usages: 0
            };
            this.keysUsage.push(usage);
            this.saveKeysUsage();
            return { key: availableKey.key, apiKey: availableKey.apiKey };
        }

        console.error(chalk.red(`❌ Нет доступных ключей для ${symbol} (заняты или исчерпаны лимиты)`));
        return null;
    }

    private markKeyAsExceeded(keyName: string) {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        console.log(chalk.red(`🚫 Помечаю ключ ${keyName} как исчерпавший лимит (exceeded)`));

        let found = false;
        this.keysUsage.forEach(usage => {
            if (usage.key === keyName && usage.start.startsWith(today)) {
                usage.isExceeded = true;
                found = true;
            }
        });

        // Если для этого ключа еще нет записи вообще (странно, но допустим), создадим фиктивную "exceeded" запись
        if (!found) {
            this.keysUsage.push({
                key: keyName,
                symbol: "GLOBAL_SYSTEM",
                start: now.toISOString().replace('T', ' ').split('.')[0],
                usages: 0,
                isExceeded: true
            });
        }

        this.saveKeysUsage();
    }

    private incrementKeyUsage(symbol: string) {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        const usage = this.keysUsage.find(
            u => u.symbol === symbol && u.start.startsWith(today)
        );

        if (usage) {
            usage.usages++;
            this.saveKeysUsage();
            console.log(chalk.gray(`📊 Ключ ${usage.key} для ${symbol}: использований ${usage.usages}`));
        }
    }

    async checkAiConnection(): Promise<boolean> {
        console.log(chalk.blue("🔍 Проверка API Gemini..."));
        try {
            const keyInfo = this.getAvailableKeyForSymbol("TEST");
            if (!keyInfo) return false;

            const ai = new GoogleGenAI({ apiKey: keyInfo.apiKey });
            const result = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [{ text: "Hi" }]
            });

            if (result.text) {
                console.log(chalk.green("✅ Gemini API доступен."));
                return true;
            }
            return false;
        } catch (error: any) {
            console.error(chalk.red("❌ Ошибка API Gemini:"), error.message);
            return false;
        }
    }

    async captureLegend(symbolConfig: SymbolConfig): Promise<{ pathEntry: string, pathContext: string }> {
        const { symbol, coinSymbol, exchange, legendUrl } = symbolConfig;
        const { debug, slowMo } = CONFIG.browser;
        const startedAt = Date.now();

        logEvent({
            symbol,
            phase: "capture_legend",
            status: "start",
            meta: { coinSymbol, exchange, entryTf: CONFIG.timeframes.entryTf, contextTf: CONFIG.timeframes.contextTf },
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
            const { entryTf, contextTf } = CONFIG.timeframes;

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

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private isWorkingTime(): boolean {
        const now = new Date();
        const currentTimeStr = now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: CONFIG.workingHours.timezone
        });

        const { start, end } = CONFIG.workingHours;
        const isWorking = currentTimeStr >= start && currentTimeStr <= end;

        if (!isWorking) {
            console.log(chalk.gray(`😴 Вне рабочего диапазона (${start} - ${end}). Текущее время (Киев): ${currentTimeStr}. Пропуск...`));
        }

        return isWorking;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private isRetryableError(error: any): boolean {
        const message = error?.message || '';
        // Check for 503 overloaded error
        return message.includes('503') ||
            message.includes('overloaded') ||
            message.includes('UNAVAILABLE');
    }

    /**
     * Получает валидный JSON ответ от AI с автоматическим retry при ошибках парсинга
     * @param ai - инстанс GoogleGenAI
     * @param contents - массив контента для запроса
     * @param symbol - символ для логирования
     * @param retries - количество попыток на валидацию JSON (не включает 503 ретраи)
     */
    private async getValidAiResponse(
        ai: GoogleGenAI,
        contents: any[],
        symbol: string,
        retries: number = 2
    ): Promise<AiResponse> {
        // Создаём копию contents для модификации при ретраях
        const workingContents = [...contents];
        const startedAt = Date.now();

        for (let attempt = 0; attempt <= retries; attempt++) {
            const result = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: workingContents,
            });

            const text = result.text?.trim();
            if (!text) {
                console.log(chalk.yellow(`⚠️ [${symbol}] AI вернул пустой ответ, попытка ${attempt + 1}/${retries + 1}`));
                logEvent({
                    symbol,
                    phase: "ai_response_parse",
                    status: "retry",
                    duration_ms: Date.now() - startedAt,
                    retry_count: attempt,
                    message: "AI returned empty response",
                });
                continue;
            }

            try {
                const parsed = parseAndValidateAiResponse(text);
                console.log(chalk.green(`✅ [${symbol}] JSON ответ успешно спарсен и валидирован`));
                logEvent({
                    symbol,
                    phase: "ai_response_parse",
                    status: "success",
                    duration_ms: Date.now() - startedAt,
                    retry_count: attempt,
                });
                return parsed;
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                console.log(chalk.yellow(`⚠️ [${symbol}] Ошибка парсинга (попытка ${attempt + 1}/${retries + 1}): ${errorMsg}`));
                logEvent({
                    symbol,
                    phase: "ai_response_parse",
                    status: attempt < retries ? "retry" : "failure",
                    duration_ms: Date.now() - startedAt,
                    retry_count: attempt,
                    error: errorMsg,
                });

                if (attempt < retries) {
                    // Добавляем инструкцию для исправления формата
                    workingContents.push({
                        text: `
ОШИБКА: ${errorMsg}

Ты нарушил формат ответа.
Верни ТОЛЬКО валидный JSON строго по схеме.
Никакого текста, markdown, комментариев.
Только чистый JSON объект.
                        `.trim(),
                    });
                }
            }
        }

        throw new Error(`AI не смог вернуть валидный JSON после ${retries + 1} попыток`);
    }

    private isQuotaError(error: any): boolean {
        const message = (error?.message || '').toString();
        // Проверяем как строку сообщения, так и структуру ошибки
        return message.includes('429') ||
            message.includes('RESOURCE_EXHAUSTED') ||
            error?.status === 'RESOURCE_EXHAUSTED' ||
            (error?.error && error.error.code === 429) ||
            (error?.error && error.error.status === 'RESOURCE_EXHAUSTED');
    }

    private enforceTradeRules(aiResponse: AiResponse): AiResponse {
        const isLong = aiResponse.lowerTimeframe.side === "LONG";
        const isShort = aiResponse.lowerTimeframe.side === "SHORT";

        const hasStrongRelevantZone =
            (isLong && aiResponse.higherTimeframe.nearestBrightLiquidityBelowStrength === "STRONG") ||
            (isShort && aiResponse.higherTimeframe.nearestBrightLiquidityAboveStrength === "STRONG");

        const tradeAllowedByRules =
            aiResponse.executionPlan.status === "TRADE_NOW" &&
            aiResponse.lowerTimeframe.canTradeNow &&
            aiResponse.lowerTimeframe.side !== "WAIT" &&
            aiResponse.lowerTimeframe.tradeTriggerType !== "NO_TRIGGER" &&
            aiResponse.lowerTimeframe.liquidityInteraction !== "BETWEEN_ZONES" &&
            aiResponse.lowerTimeframe.liquidityInteraction !== "NONE" &&
            aiResponse.lowerTimeframe.entryPrice !== null &&
            aiResponse.lowerTimeframe.stopLoss !== null &&
            aiResponse.lowerTimeframe.takeProfit1 !== null &&
            aiResponse.lowerTimeframe.rr !== null &&
            aiResponse.lowerTimeframe.rr >= 2.5 &&
            hasStrongRelevantZone;

        const isChasingLong =
            aiResponse.lowerTimeframe.side === "LONG" &&
            aiResponse.higherTimeframe.trendQuality === "OVEREXTENDED" &&
            aiResponse.lowerTimeframe.priceLocation === "EXTENDED_FROM_ZONE";

        const isChasingShort =
            aiResponse.lowerTimeframe.side === "SHORT" &&
            aiResponse.higherTimeframe.trendQuality === "OVEREXTENDED" &&
            aiResponse.lowerTimeframe.priceLocation === "EXTENDED_FROM_ZONE";

        if (tradeAllowedByRules && !isChasingLong && !isChasingShort) {
            aiResponse.executionPlan.waitType = null;
            return aiResponse;
        }

        aiResponse.lowerTimeframe.side = "WAIT";
        aiResponse.lowerTimeframe.canTradeNow = false;
        aiResponse.lowerTimeframe.entryPrice = null;
        aiResponse.lowerTimeframe.stopLoss = null;
        aiResponse.lowerTimeframe.takeProfit1 = null;
        aiResponse.lowerTimeframe.takeProfit2 = null;
        aiResponse.lowerTimeframe.rr = null;
        aiResponse.lowerTimeframe.tradeTriggerType = "NO_TRIGGER";
        aiResponse.executionPlan.status = "WAIT";

        if (!aiResponse.executionPlan.waitType) {
            if (aiResponse.lowerTimeframe.priceLocation === "EXTENDED_FROM_ZONE") {
                aiResponse.executionPlan.waitType = "WAIT_OVEREXTENDED";
            } else if (
                aiResponse.lowerTimeframe.liquidityInteraction === "BETWEEN_ZONES" ||
                aiResponse.lowerTimeframe.liquidityInteraction === "NONE"
            ) {
                aiResponse.executionPlan.waitType = "WAIT_NO_NEAR_RISK_POINT";
            } else {
                aiResponse.executionPlan.waitType = "WAIT_NO_NEAR_RISK_POINT";
            }
        }

        return aiResponse;
    }

    private normalizeActivationTrigger(value: string): string {
        return value
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private areActivationTriggersSimilar(current: string, previous: string): boolean {
        const normalizedCurrent = this.normalizeActivationTrigger(current);
        const normalizedPrevious = this.normalizeActivationTrigger(previous);

        if (!normalizedCurrent || !normalizedPrevious) {
            return normalizedCurrent === normalizedPrevious;
        }

        if (
            normalizedCurrent === normalizedPrevious ||
            normalizedCurrent.includes(normalizedPrevious) ||
            normalizedPrevious.includes(normalizedCurrent)
        ) {
            return true;
        }

        const currentWords = new Set(normalizedCurrent.split(" "));
        const previousWords = new Set(normalizedPrevious.split(" "));
        const intersectionSize = [...currentWords].filter(word => previousWords.has(word)).length;
        const unionSize = new Set([...currentWords, ...previousWords]).size;

        return unionSize > 0 && intersectionSize / unionSize >= 0.8;
    }

    private shouldSkipDuplicateWait(symbol: string, aiResponse: AiResponse): boolean {
        if (aiResponse.executionPlan.status !== "WAIT") {
            delete this.lastWaitNotifications[symbol];
            this.saveWaitNotifications();
            return false;
        }

        const previous = this.lastWaitNotifications[symbol];
        const current: WaitNotificationState = {
            waitType: aiResponse.executionPlan.waitType,
            liquidityInteraction: aiResponse.lowerTimeframe.liquidityInteraction,
            activationTrigger: aiResponse.executionPlan.activationTrigger,
        };

        const isDuplicate =
            previous !== undefined &&
            previous.waitType === current.waitType &&
            previous.liquidityInteraction === current.liquidityInteraction &&
            this.areActivationTriggersSimilar(current.activationTrigger, previous.activationTrigger);

        if (!isDuplicate) {
            this.lastWaitNotifications[symbol] = current;
            this.saveWaitNotifications();
        }

        return isDuplicate;
    }

    async analyzeAndSend(symbol: string, paths: { pathEntry: string, pathContext: string }) {
        const startedAt = Date.now();
        console.log(chalk.yellow(`[${symbol}] Отправка в AI для анализа...`));
        logEvent({
            symbol,
            phase: "analyze_and_send",
            status: "start",
            screenshot_path: `${paths.pathEntry},${paths.pathContext}`,
        });

        const keyInfo = this.getAvailableKeyForSymbol(symbol);
        if (!keyInfo) {
            console.error(chalk.red(`❌ [${symbol}] Нет доступных ключей. Пропуск цикла.`));
            logEvent({
                symbol,
                phase: "analyze_and_send",
                status: "failure",
                duration_ms: Date.now() - startedAt,
                screenshot_path: `${paths.pathEntry},${paths.pathContext}`,
                error: "No available Gemini keys",
            });
            return;
        }

        const ai = new GoogleGenAI({ apiKey: keyInfo.apiKey });
        const base64ImageEntry = fs.readFileSync(paths.pathEntry, { encoding: "base64" });
        const base64ImageContext = fs.readFileSync(paths.pathContext, { encoding: "base64" });

        const contextText = this.tradeState.active
            ? `У нас уже есть открытая позиция ${this.tradeState.side}. Оцени, есть ли новый валидный trigger прямо сейчас, или корректный ответ — WAIT. Не используй HOLD/CLOSE.`
            : `Открытых позиций нет. Оцени, есть ли валидный торговый trigger прямо сейчас. Если trigger не завершен, верни WAIT с конкретным activationTrigger.`;

        const requestContents = [
            { text: getSystemPrompt(CONFIG.timeframes.entryTf, CONFIG.timeframes.contextTf) },
            { text: contextText },
            { text: `Проанализируй текущую ситуацию по ${symbol} на основе двух скриншотов: ${CONFIG.timeframes.entryTf} (точка входа) и ${CONFIG.timeframes.contextTf} (старший тренд).` },
            {
                inlineData: {
                    mimeType: "image/png",
                    data: base64ImageEntry,
                },
            },
            {
                inlineData: {
                    mimeType: "image/png",
                    data: base64ImageContext,
                },
            },
        ];

        // Retry delays for 503 errors: 1 min, 2 min, 4 min
        const retryDelays = [60 * 1000, 2 * 60 * 1000, 4 * 60 * 1000];

        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
            try {
                // getValidAiResponse handles JSON validation retries internally
                const aiStartedAt = Date.now();
                let aiResponse = await this.getValidAiResponse(ai, requestContents, symbol, 2);
                logEvent({
                    symbol,
                    phase: "ai_generate_content",
                    status: "success",
                    duration_ms: Date.now() - aiStartedAt,
                    ai_key_used: keyInfo.key,
                    retry_count: attempt,
                });

                // Применяем жесткий rule-engine поверх ответа модели
                aiResponse = this.enforceTradeRules(aiResponse);
                logEvent({
                    symbol,
                    phase: "trade_rules",
                    status: aiResponse.executionPlan.status === "TRADE_NOW" ? "success" : "skip",
                    ai_key_used: keyInfo.key,
                    retry_count: attempt,
                    meta: {
                        status: aiResponse.executionPlan.status,
                        waitType: aiResponse.executionPlan.waitType,
                        side: aiResponse.lowerTimeframe.side,
                        liquidityInteraction: aiResponse.lowerTimeframe.liquidityInteraction,
                        tradeTriggerType: aiResponse.lowerTimeframe.tradeTriggerType,
                    },
                });

                this.incrementKeyUsage(symbol);
                this.saveStateFromAiResponse(aiResponse);

                // Format response for Telegram
                const formattedMessage = formatAiResponseForTelegram(
                    aiResponse,
                    symbol,
                    CONFIG.timeframes.entryTf,
                    CONFIG.timeframes.contextTf
                );

                if (this.shouldSkipDuplicateWait(symbol, aiResponse)) {
                    console.log(chalk.gray(`[${symbol}] Duplicate WAIT skipped: ${aiResponse.executionPlan.waitType}`));
                    logEvent({
                        symbol,
                        phase: "telegram_send",
                        status: "skip",
                        duration_ms: Date.now() - startedAt,
                        ai_key_used: keyInfo.key,
                        retry_count: attempt,
                        message: "Duplicate WAIT skipped",
                        meta: {
                            waitType: aiResponse.executionPlan.waitType,
                            liquidityInteraction: aiResponse.lowerTimeframe.liquidityInteraction,
                        },
                    });
                    return;
                }

                // WAIT можно отправлять только текстом, а TRADE_NOW — с картинкой
                const telegramStartedAt = Date.now();
                if (aiResponse.executionPlan.status === "TRADE_NOW") {
                    await this.tgBot.telegram.sendPhoto(
                        CONFIG.tgChatId,
                        Input.fromLocalFile(paths.pathEntry),
                        {
                            caption: `🚀 <b>${symbol} ${CONFIG.timeframes.entryTf}/${CONFIG.timeframes.contextTf} TRADE NOW</b>`,
                            parse_mode: "HTML"
                        }
                    );

                    await this.tgBot.telegram.sendMessage(
                        CONFIG.tgChatId,
                        formattedMessage,
                        { parse_mode: "HTML" }
                    );
                } else {
                    await this.tgBot.telegram.sendMessage(
                        CONFIG.tgChatId,
                        formattedMessage,
                        { parse_mode: "HTML" }
                    );
                }

                logEvent({
                    symbol,
                    phase: "telegram_send",
                    status: "success",
                    duration_ms: Date.now() - telegramStartedAt,
                    screenshot_path: aiResponse.executionPlan.status === "TRADE_NOW" ? paths.pathEntry : undefined,
                    ai_key_used: keyInfo.key,
                    retry_count: attempt,
                    meta: { status: aiResponse.executionPlan.status },
                });
                logEvent({
                    symbol,
                    phase: "analyze_and_send",
                    status: "success",
                    duration_ms: Date.now() - startedAt,
                    screenshot_path: `${paths.pathEntry},${paths.pathContext}`,
                    ai_key_used: keyInfo.key,
                    retry_count: attempt,
                });
                console.log(chalk.green(`✅ Сигнал по ${symbol} отправлен в Telegram!`));
                return; // Success, exit function
            } catch (error: any) {
                if (this.isQuotaError(error)) {
                    console.error(chalk.red(`⚠️ [${symbol}] Лимит ключа ${keyInfo.key} исчерпан (429).`));
                    logEvent({
                        symbol,
                        phase: "ai_generate_content",
                        status: "failure",
                        duration_ms: Date.now() - startedAt,
                        ai_key_used: keyInfo.key,
                        retry_count: attempt,
                        error: error?.message || String(error),
                    });
                    this.markKeyAsExceeded(keyInfo.key);

                    console.log(chalk.cyan(`🔄 [${symbol}] Пробую переключиться на другой ключ...`));
                    // Рекурсивный вызов для попытки с новым ключом
                    return this.analyzeAndSend(symbol, paths);
                }

                if (this.isRetryableError(error) && attempt < retryDelays.length) {
                    const delayMs = retryDelays[attempt];
                    const delayMin = delayMs / 60000;
                    console.log(chalk.yellow(`⚠️ [${symbol}] Модель перегружена (503). Попытка ${attempt + 1}/${retryDelays.length}. Повтор через ${delayMin} мин...`));
                    logEvent({
                        symbol,
                        phase: "ai_generate_content",
                        status: "retry",
                        duration_ms: Date.now() - startedAt,
                        ai_key_used: keyInfo.key,
                        retry_count: attempt + 1,
                        error: error?.message || String(error),
                        meta: { retryDelayMs: delayMs },
                    });
                    await this.sleep(delayMs);
                } else if (this.isRetryableError(error)) {
                    console.error(chalk.red(`❌ [${symbol}] Все ${retryDelays.length} попытки (503) исчерпаны. Пропускаем до следующего запуска.`));
                    logEvent({
                        symbol,
                        phase: "ai_generate_content",
                        status: "failure",
                        duration_ms: Date.now() - startedAt,
                        ai_key_used: keyInfo.key,
                        retry_count: attempt,
                        error: error?.message || String(error),
                    });
                    return;
                } else {
                    // Non-retryable error (including JSON validation failures after all retries)
                    console.error(chalk.red(`❌ Ошибка анализа ${symbol}:`), error.message);
                    logEvent({
                        symbol,
                        phase: "analyze_and_send",
                        status: "failure",
                        duration_ms: Date.now() - startedAt,
                        screenshot_path: `${paths.pathEntry},${paths.pathContext}`,
                        ai_key_used: keyInfo.key,
                        retry_count: attempt,
                        error: error?.message || String(error),
                    });
                    return;
                }
            }
        }
    }

    /**
     * Сохраняет состояние на основе структурированного AI ответа
     */
    private saveStateFromAiResponse(response: AiResponse) {
        if (
            response.executionPlan.status === "TRADE_NOW" &&
            response.lowerTimeframe.canTradeNow &&
            (response.lowerTimeframe.side === "LONG" || response.lowerTimeframe.side === "SHORT")
        ) {
            this.tradeState = {
                active: true,
                side: response.lowerTimeframe.side,
                entry: response.lowerTimeframe.entryPrice,
                stopLoss: response.lowerTimeframe.stopLoss,
                takeProfit1: response.lowerTimeframe.takeProfit1,
                takeProfit2: response.lowerTimeframe.takeProfit2,
                triggerType: response.lowerTimeframe.tradeTriggerType,
                interaction: response.lowerTimeframe.liquidityInteraction,
            };
        } else {
            this.tradeState = { active: false, side: null };
        }

        fs.writeFileSync(STATE_FILE, JSON.stringify(this.tradeState, null, 2));
    }

    /**
     * Ждет закрытия свечи через WebSocket Binance
     */
    private async waitForCandleClose(interval: string): Promise<void> {
        const symbol = "btcusdt"; // Используем BTCUSDT для шедуллера
        const url = `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`;

        console.log(chalk.blue(`📡 Подключение к Binance WebSocket для отслеживания закрытия свечи ${interval}...`));

        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            let resolved = false;

            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.k && msg.k.x) { // x = isFinalized
                    console.log(chalk.green(`🔔 Свеча ${interval} закрыта! Запускаем анализ...`));
                    if (!resolved) {
                        resolved = true;
                        ws.close();
                        // Небольшая пауза 2-3 сек, чтобы графики на coinglass тоже обновились
                        setTimeout(resolve, 3000);
                    }
                }
            });

            ws.on('error', (err) => {
                console.error(chalk.red("❌ WebSocket Error:"), err.message);
                if (!resolved) {
                    resolved = true;
                    ws.close();
                    // В случае ошибки fallback на 30 сек и пробуем снова
                    setTimeout(resolve, 30000);
                }
            });

            ws.on('close', () => {
                if (!resolved) {
                    console.log(chalk.yellow("⚠️ WebSocket закрыт преждевременно, реконнект через 5 сек..."));
                    setTimeout(() => this.waitForCandleClose(interval).then(resolve), 5000);
                }
            });
        });
    }

    async run() {
        console.log(chalk.magenta.bold("=== QUANT BOT STARTING ==="));
        // if (!(await this.checkAiConnection())) return;

        let isFirstRun = true;

        while (true) {
            this.checkAndResetKeys(); // Проверяем сброс ключей перед каждой итерацией

            // Проверка рабочего времени
            if (!this.isWorkingTime()) {
                console.log(chalk.yellow(`⏳ Ожидание следующего цикла (вне рабочих часов)...`));
                await this.waitForCandleClose(CONFIG.kline);
                continue;
            }

            // Если это первый запуск и флаг runInitialAnalysis = false, то сначала ждем
            if (isFirstRun && !CONFIG.runInitialAnalysis) {
                console.log(chalk.yellow(`⏳ Пропуск первого анализа по конфигу. Ждем закрытия первой свечи ${CONFIG.kline}...`));
                await this.waitForCandleClose(CONFIG.kline);
                isFirstRun = false;
                continue;
            }

            const activeSymbols = CONFIG.symbols.filter(s => s.isActive);
            console.log(chalk.blue(`📋 Активных символов: ${activeSymbols.length} (${activeSymbols.map(s => s.symbol).join(', ')})`));

            for (const symbolConfig of activeSymbols) {
                try {
                    console.log(chalk.cyan(`\n🔄 Обработка ${symbolConfig.symbol} (${symbolConfig.coinSymbol} @ ${symbolConfig.exchange})...`));
                    const paths = await this.captureLegend(symbolConfig);

                    // Кропаем перед анализом
                    console.log(chalk.yellow(`[${symbolConfig.symbol}] Подготовка скриншотов (кроп)...`));
                    const cropStartedAt = Date.now();
                    try {
                        await this.imageProcessor.cropImages([paths.pathEntry, paths.pathContext]);
                        logEvent({
                            symbol: symbolConfig.symbol,
                            phase: "crop_images",
                            status: "success",
                            duration_ms: Date.now() - cropStartedAt,
                            screenshot_path: `${paths.pathEntry},${paths.pathContext}`,
                        });
                    } catch (cropErr: any) {
                        console.error(chalk.red(`❌ Ошибка кропа для ${symbolConfig.symbol}:`), cropErr.message);
                        logEvent({
                            symbol: symbolConfig.symbol,
                            phase: "crop_images",
                            status: "failure",
                            duration_ms: Date.now() - cropStartedAt,
                            screenshot_path: `${paths.pathEntry},${paths.pathContext}`,
                            error: cropErr?.message || String(cropErr),
                        });
                    }

                    await this.analyzeAndSend(symbolConfig.symbol, paths);
                    if (fs.existsSync(paths.pathEntry)) fs.unlinkSync(paths.pathEntry);
                    if (fs.existsSync(paths.pathContext)) fs.unlinkSync(paths.pathContext);
                } catch (e) {
                    console.error(chalk.red(`Ошибка в цикле для ${symbolConfig.symbol}:`), e);
                }
            }

            isFirstRun = false;
            console.log(chalk.gray(`💤 Ждем следующую свечу ${CONFIG.kline}...`));
            await this.waitForCandleClose(CONFIG.kline);
        }
    }
}

const bot = new QuantBot();
bot.run();

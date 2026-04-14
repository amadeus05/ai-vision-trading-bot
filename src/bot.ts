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

// ===================== TYPES =====================
interface KeyUsage {
    key: string;
    symbol: string;
    start: string;
    usages: number;
    isExceeded?: boolean;
}

// ===================== BOT =====================
class QuantBot {
    private tgBot: Telegraf;
    private browser: Browser | null = null;
    private tradeState: any = { active: false, side: null };
    private keysUsage: KeyUsage[] = [];
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
            await page.screenshot({ path: pathEntry, fullPage: false });
            console.log(chalk.green(`📸 Скриншот ${entryTf} успешно сделан!`));

            // ==== ПЕРЕКЛЮЧЕНИЕ НА СТАРШИЙ ТАЙМФРЕЙМ ====
            console.log(chalk.blue(`📅 Переключение на ${contextTf}...`));
            const activeContext = await page.$(`div.b-h.act:has-text("${contextTf}")`);
            if (!activeContext) {
                await page.click(`div.b-h:has-text("${contextTf}")`);
                await page.waitForTimeout(15000); // Ждем прогрузки
            }
            const pathContext = `./screenshots/${symbol.toLowerCase()}_${contextTf.toLowerCase()}.png`;
            await page.screenshot({ path: pathContext, fullPage: false });
            console.log(chalk.green(`📸 Скриншот ${contextTf} успешно сделан!`));

            return { pathEntry, pathContext };
        } finally {
            await page.close();
            await context.close();
        }
    }

    /**
     * Переключает монету через модальное окно поиска
     */
    private async switchCoin(page: Page, coinSymbol: string, exchange: string): Promise<void> {
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

        for (let attempt = 0; attempt <= retries; attempt++) {
            const result = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: workingContents,
            });

            const text = result.text?.trim();
            if (!text) {
                console.log(chalk.yellow(`⚠️ [${symbol}] AI вернул пустой ответ, попытка ${attempt + 1}/${retries + 1}`));
                continue;
            }

            try {
                const parsed = parseAndValidateAiResponse(text);
                console.log(chalk.green(`✅ [${symbol}] JSON ответ успешно спарсен и валидирован`));
                return parsed;
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                console.log(chalk.yellow(`⚠️ [${symbol}] Ошибка парсинга (попытка ${attempt + 1}/${retries + 1}): ${errorMsg}`));

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

    async analyzeAndSend(symbol: string, paths: { pathEntry: string, pathContext: string }) {
        console.log(chalk.yellow(`[${symbol}] Отправка в AI для анализа...`));

        const keyInfo = this.getAvailableKeyForSymbol(symbol);
        if (!keyInfo) {
            console.error(chalk.red(`❌ [${symbol}] Нет доступных ключей. Пропуск цикла.`));
            return;
        }

        const ai = new GoogleGenAI({ apiKey: keyInfo.apiKey });
        const base64ImageEntry = fs.readFileSync(paths.pathEntry, { encoding: "base64" });
        const base64ImageContext = fs.readFileSync(paths.pathContext, { encoding: "base64" });

        const contextText = this.tradeState.active
            ? `ВНИМАНИЕ: У нас открыта позиция ${this.tradeState.side}. Проанализируй график: нужно ли продолжать держать (HOLD) или пора закрывать (CLOSE)?`
            : `Сейчас открытых позиций нет. Проанализируй график и найди точку входа.`;

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
                const aiResponse = await this.getValidAiResponse(ai, requestContents, symbol, 2);

                this.incrementKeyUsage(symbol);
                this.saveStateFromAiResponse(aiResponse);

                // Format response for Telegram
                const formattedMessage = formatAiResponseForTelegram(aiResponse, symbol);

                // Telegram photo captions are limited to 1024 chars
                // Send photo with short header, then full analysis as separate message
                await this.tgBot.telegram.sendPhoto(
                    CONFIG.tgChatId,
                    Input.fromLocalFile(paths.pathEntry),
                    {
                        caption: `🚀 <b>${symbol} ${CONFIG.timeframes.entryTf}/${CONFIG.timeframes.contextTf} UPDATE</b>`,
                        parse_mode: "HTML"
                    }
                );

                // Send formatted analysis as separate message
                await this.tgBot.telegram.sendMessage(
                    CONFIG.tgChatId,
                    formattedMessage,
                    { parse_mode: "HTML" }
                );

                console.log(chalk.green(`✅ Сигнал по ${symbol} отправлен в Telegram!`));
                return; // Success, exit function
            } catch (error: any) {
                if (this.isQuotaError(error)) {
                    console.error(chalk.red(`⚠️ [${symbol}] Лимит ключа ${keyInfo.key} исчерпан (429).`));
                    this.markKeyAsExceeded(keyInfo.key);

                    console.log(chalk.cyan(`🔄 [${symbol}] Пробую переключиться на другой ключ...`));
                    // Рекурсивный вызов для попытки с новым ключом
                    return this.analyzeAndSend(symbol, paths);
                }

                if (this.isRetryableError(error) && attempt < retryDelays.length) {
                    const delayMs = retryDelays[attempt];
                    const delayMin = delayMs / 60000;
                    console.log(chalk.yellow(`⚠️ [${symbol}] Модель перегружена (503). Попытка ${attempt + 1}/${retryDelays.length}. Повтор через ${delayMin} мин...`));
                    await this.sleep(delayMs);
                } else if (this.isRetryableError(error)) {
                    console.error(chalk.red(`❌ [${symbol}] Все ${retryDelays.length} попытки (503) исчерпаны. Пропускаем до следующего запуска.`));
                    return;
                } else {
                    // Non-retryable error (including JSON validation failures after all retries)
                    console.error(chalk.red(`❌ Ошибка анализа ${symbol}:`), error.message);
                    return;
                }
            }
        }
    }

    /**
     * Сохраняет состояние на основе структурированного AI ответа
     */
    private saveStateFromAiResponse(response: AiResponse) {
        if (response.signal === "LONG") {
            this.tradeState = { active: true, side: "LONG" };
        } else if (response.signal === "SHORT") {
            this.tradeState = { active: true, side: "SHORT" };
        }
        // WAIT не меняет состояние - сохраняем текущее
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
                    try {
                        await this.imageProcessor.cropImages([paths.pathEntry, paths.pathContext]);
                    } catch (cropErr: any) {
                        console.error(chalk.red(`❌ Ошибка кропа для ${symbolConfig.symbol}:`), cropErr.message);
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

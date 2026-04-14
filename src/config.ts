import * as dotenv from "dotenv";
import { AiResponse } from "./schemas/aiResponse";

dotenv.config();

// Доступные таймфреймы CoinGlass
export enum Timeframe {
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

export interface TimeframeConfig {
    entryTf: Timeframe;    // основной (младший) - точка входа
    contextTf: Timeframe;  // старший (контекст рынка)
}

export interface SymbolConfig {
    symbol: string;      // Название монеты для отображения (например, "ETHUSDT")
    coinSymbol: string;  // Символ для поиска в CoinGlass (например, "ETH")
    exchange: string;    // Биржа (например, "Bybit")
    legendUrl: string;
    isActive: boolean;
}

export const CONFIG = {
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

export const STATE_FILE = "./trade_state.json";
export const KEYS_USAGE_FILE = "./keys_usage.json";
export const WAIT_NOTIFICATIONS_FILE = "./wait_notifications.json";

// ===================== TYPES =====================
export interface KeyUsage {
    key: string;
    symbol: string;
    start: string;
    usages: number;
    isExceeded?: boolean;
}

export interface WaitNotificationState {
    waitType: AiResponse["executionPlan"]["waitType"];
    liquidityInteraction: AiResponse["lowerTimeframe"]["liquidityInteraction"];
    activationTrigger: string;
}

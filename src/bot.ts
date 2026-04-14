import * as fs from "fs";
import chalk from "chalk";
import { CONFIG, SymbolConfig } from "./config";
import { CoinglassClient } from "./coinglassClient";
import { ImageProcessor } from "./imageProcessor";
import { Notifier } from "./notifier";
import { Scheduler } from "./scheduler";
import { SignalEngine } from "./signalEngine";
import { StateStore } from "./stateStore";
import { logEvent } from "./structuredLogger";

class QuantBot {
    private readonly coinglassClient = new CoinglassClient(CONFIG);
    private readonly imageProcessor = new ImageProcessor();
    private readonly notifier = new Notifier(CONFIG);
    private readonly scheduler = new Scheduler(CONFIG);
    private readonly signalEngine = new SignalEngine(CONFIG);
    private readonly stateStore = new StateStore(CONFIG);

    constructor() {
        if (!CONFIG.tgToken) {
            console.error(chalk.red("Error: TELEGRAM_BOT_TOKEN is missing in .env"));
            process.exit(1);
        }
        if (CONFIG.gemini.filter(k => k.apiKey).length === 0) {
            console.error(chalk.red("Error: no valid GEMINI_API_KEY configured"));
            process.exit(1);
        }
    }

    private async processSymbol(symbolConfig: SymbolConfig): Promise<void> {
        console.log(chalk.cyan("\nProcessing " + symbolConfig.symbol + " (" + symbolConfig.coinSymbol + " @ " + symbolConfig.exchange + ")..."));
        const paths = await this.coinglassClient.captureLegend(symbolConfig);
        try {
            console.log(chalk.yellow("[" + symbolConfig.symbol + "] Preparing screenshots (crop)..."));
            const cropStartedAt = Date.now();
            try {
                await this.imageProcessor.cropImages([paths.pathEntry, paths.pathContext]);
                logEvent({ symbol: symbolConfig.symbol, phase: "crop_images", status: "success", duration_ms: Date.now() - cropStartedAt, screenshot_path: paths.pathEntry + "," + paths.pathContext });
            } catch (cropErr: any) {
                console.error(chalk.red("Crop error for " + symbolConfig.symbol + ":"), cropErr.message);
                logEvent({ symbol: symbolConfig.symbol, phase: "crop_images", status: "failure", duration_ms: Date.now() - cropStartedAt, screenshot_path: paths.pathEntry + "," + paths.pathContext, error: cropErr?.message || String(cropErr) });
            }
            const startedAt = Date.now();
            const result = await this.signalEngine.analyze(symbolConfig.symbol, paths, this.stateStore.getTradeState(), symbol => this.stateStore.getAvailableKeyForSymbol(symbol), key => this.stateStore.markKeyAsExceeded(key), symbol => this.stateStore.incrementKeyUsage(symbol));
            if (!result) return;
            this.stateStore.saveStateFromAiResponse(result.response);
            if (this.stateStore.shouldSkipDuplicateWait(symbolConfig.symbol, result.response)) {
                logEvent({ symbol: symbolConfig.symbol, phase: "telegram_send", status: "skip", duration_ms: Date.now() - startedAt, ai_key_used: result.keyName, retry_count: result.retryCount, message: "Duplicate WAIT skipped", meta: { waitType: result.response.executionPlan.waitType, liquidityInteraction: result.response.lowerTimeframe.liquidityInteraction } });
                return;
            }
            const telegramStartedAt = Date.now();
            await this.notifier.sendSignal(symbolConfig.symbol, result.response, paths);
            logEvent({ symbol: symbolConfig.symbol, phase: "telegram_send", status: "success", duration_ms: Date.now() - telegramStartedAt, screenshot_path: result.response.executionPlan.status === "TRADE_NOW" ? paths.pathEntry : undefined, ai_key_used: result.keyName, retry_count: result.retryCount, meta: { status: result.response.executionPlan.status } });
            logEvent({ symbol: symbolConfig.symbol, phase: "analyze_and_send", status: "success", duration_ms: Date.now() - startedAt, screenshot_path: paths.pathEntry + "," + paths.pathContext, ai_key_used: result.keyName, retry_count: result.retryCount });
            console.log(chalk.green("Signal for " + symbolConfig.symbol + " was sent to Telegram."));
        } finally {
            if (fs.existsSync(paths.pathEntry)) fs.unlinkSync(paths.pathEntry);
            if (fs.existsSync(paths.pathContext)) fs.unlinkSync(paths.pathContext);
        }
    }

    async run() {
        console.log(chalk.magenta.bold("=== QUANT BOT STARTING ==="));
        let isFirstRun = true;
        while (true) {
            this.stateStore.checkAndResetKeys();
            if (!this.scheduler.isWorkingTime()) {
                console.log(chalk.yellow("Waiting for the next cycle outside working hours..."));
                await this.scheduler.waitForCandleClose(CONFIG.kline);
                continue;
            }
            if (isFirstRun && !CONFIG.runInitialAnalysis) {
                console.log(chalk.yellow("Initial analysis is disabled by config. Waiting for the first " + CONFIG.kline + " candle close..."));
                await this.scheduler.waitForCandleClose(CONFIG.kline);
                isFirstRun = false;
                continue;
            }
            const activeSymbols = CONFIG.symbols.filter(s => s.isActive);
            console.log(chalk.blue("Active symbols: " + activeSymbols.length + " (" + activeSymbols.map(s => s.symbol).join(", ") + ")"));
            for (const symbolConfig of activeSymbols) {
                try { await this.processSymbol(symbolConfig); } catch (e) { console.error(chalk.red("Cycle error for " + symbolConfig.symbol + ":"), e); }
            }
            isFirstRun = false;
            console.log(chalk.gray("Waiting for the next " + CONFIG.kline + " candle..."));
            await this.scheduler.waitForCandleClose(CONFIG.kline);
        }
    }
}

const bot = new QuantBot();
bot.run();

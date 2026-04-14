import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import chalk from "chalk";
import { AiResponse, parseAndValidateAiResponse } from "./schemas/aiResponse";
import { CONFIG } from "./config";
import { getSystemPrompt } from "./prompts";
import { logEvent } from "./structuredLogger";

export interface SignalEngineResult {
    response: AiResponse;
    keyName: string;
    retryCount: number;
}

export class SignalEngine {
    constructor(private readonly config = CONFIG) {}

private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

    async analyze(symbol: string, paths: { pathEntry: string, pathContext: string }, tradeState: any, getKey: (symbol: string) => { key: string; apiKey: string } | null, onQuotaExceeded: (key: string) => void, onUsage: (symbol: string) => void): Promise<SignalEngineResult | null> {
        const startedAt = Date.now();
        const keyInfo = getKey(symbol);
        if (!keyInfo) {
            logEvent({ symbol, phase: "analyze_and_send", status: "failure", duration_ms: Date.now() - startedAt, error: "No available Gemini keys" });
            return null;
        }

        const ai = new GoogleGenAI({ apiKey: keyInfo.apiKey });
        const base64ImageEntry = fs.readFileSync(paths.pathEntry, { encoding: "base64" });
        const base64ImageContext = fs.readFileSync(paths.pathContext, { encoding: "base64" });
        const contextText = tradeState.active
            ? `There is already an open ${tradeState.side} position. Check whether a new valid trigger exists right now; otherwise return WAIT. Do not use HOLD or CLOSE.`
            : "There are no open positions. Check whether a valid trading trigger exists right now. If the trigger is not complete, return WAIT with a concrete activationTrigger.";
        const requestContents = [
            { text: getSystemPrompt(this.config.timeframes.entryTf, this.config.timeframes.contextTf) },
            { text: contextText },
            { text: `Analyze ${symbol} using two screenshots: ${this.config.timeframes.entryTf} as the entry timeframe and ${this.config.timeframes.contextTf} as the higher-timeframe context.` },
            { inlineData: { mimeType: "image/png", data: base64ImageEntry } },
            { inlineData: { mimeType: "image/png", data: base64ImageContext } },
        ];
        const retryDelays = [60 * 1000, 2 * 60 * 1000, 4 * 60 * 1000];

        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
            try {
                const aiStartedAt = Date.now();
                let response = await this.getValidAiResponse(ai, requestContents, symbol, 2);
                logEvent({ symbol, phase: "ai_generate_content", status: "success", duration_ms: Date.now() - aiStartedAt, ai_key_used: keyInfo.key, retry_count: attempt });
                response = this.enforceTradeRules(response);
                logEvent({ symbol, phase: "trade_rules", status: response.executionPlan.status === "TRADE_NOW" ? "success" : "skip", ai_key_used: keyInfo.key, retry_count: attempt, meta: { status: response.executionPlan.status, waitType: response.executionPlan.waitType, side: response.lowerTimeframe.side, liquidityInteraction: response.lowerTimeframe.liquidityInteraction, tradeTriggerType: response.lowerTimeframe.tradeTriggerType } });
                onUsage(symbol);
                return { response, keyName: keyInfo.key, retryCount: attempt };
            } catch (error: any) {
                if (this.isQuotaError(error)) {
                    logEvent({ symbol, phase: "ai_generate_content", status: "failure", duration_ms: Date.now() - startedAt, ai_key_used: keyInfo.key, retry_count: attempt, error: error?.message || String(error) });
                    onQuotaExceeded(keyInfo.key);
                    return this.analyze(symbol, paths, tradeState, getKey, onQuotaExceeded, onUsage);
                }

                if (this.isRetryableError(error) && attempt < retryDelays.length) {
                    const delayMs = retryDelays[attempt];
                    logEvent({ symbol, phase: "ai_generate_content", status: "retry", duration_ms: Date.now() - startedAt, ai_key_used: keyInfo.key, retry_count: attempt + 1, error: error?.message || String(error), meta: { retryDelayMs: delayMs } });
                    await this.sleep(delayMs);
                    continue;
                }

                logEvent({ symbol, phase: "ai_generate_content", status: "failure", duration_ms: Date.now() - startedAt, ai_key_used: keyInfo.key, retry_count: attempt, error: error?.message || String(error) });
                return null;
            }
        }

        return null;
    }
}

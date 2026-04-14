import { z } from "zod";

// ===================== HELPERS =====================

const LiquidityStrengthSchema = z.enum(["STRONG", "MEDIUM", "WEAK", "NONE"]);

function extractJsonFromText(raw: string): string {
    const jsonBlockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        return jsonBlockMatch[1].trim();
    }

    const codeBlockMatch = raw.match(/```\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return jsonMatch[0];
    }

    return raw.trim();
}

function formatPrice(value: number | null): string {
    if (value === null) return "—";

    if (value >= 1000) return value.toFixed(2);
    if (value >= 100) return value.toFixed(3);
    if (value >= 1) return value.toFixed(4);
    return value.toFixed(6);
}

// ===================== AI RESPONSE SCHEMA =====================

export const AiResponseSchema = z.object({
    higherTimeframe: z.object({
        marketBias: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
        marketState: z.enum(["TREND", "RANGE", "EXPANSION", "DISTRIBUTION", "ACCUMULATION"]),
        trendQuality: z.enum(["CLEAN", "CHOPPY", "OVEREXTENDED"]),
        nearestBrightLiquidityAbove: z.number().nullable(),
        nearestBrightLiquidityBelow: z.number().nullable(),
        nearestBrightLiquidityAboveStrength: LiquidityStrengthSchema,
        nearestBrightLiquidityBelowStrength: LiquidityStrengthSchema,
        cvdState: z.enum(["CONFIRM", "DIVERGENCE", "FLAT"]),
        oiState: z.enum(["BUILDUP", "FLUSH", "FLAT"]),
        fundingState: z.enum(["LONG_CROWDED", "SHORT_CROWDED", "NEUTRAL"]),
    }),
    lowerTimeframe: z.object({
        priceLocation: z.enum(["AT_BRIGHT_ZONE", "BETWEEN_ZONES", "EXTENDED_FROM_ZONE"]),
        liquidityInteraction: z.enum([
            "APPROACHING_UPPER_ZONE",
            "APPROACHING_LOWER_ZONE",
            "INSIDE_UPPER_ZONE",
            "INSIDE_LOWER_ZONE",
            "REJECTED_FROM_UPPER",
            "RECLAIMED_LOWER",
            "SWEPT_UPPER",
            "SWEPT_LOWER",
            "BETWEEN_ZONES",
            "NONE",
        ]),
        entrySetup: z.enum(["PULLBACK", "SWEEP", "RETEST", "BREAKOUT_CONTINUATION", "NONE"]),
        tradeTriggerType: z.enum([
            "SWEEP_AND_RECLAIM",
            "RETEST_HOLD",
            "REJECTION_FROM_UPPER_ZONE",
            "ACCEPTANCE_ABOVE_ZONE",
            "ACCEPTANCE_BELOW_ZONE",
            "NO_TRIGGER",
        ]),
        canTradeNow: z.boolean(),
        side: z.enum(["LONG", "SHORT", "WAIT"]),
        entryPrice: z.number().nullable(),
        stopLoss: z.number().nullable(),
        takeProfit1: z.number().nullable(),
        takeProfit2: z.number().nullable(),
        rr: z.number().nullable(),
    }),
    executionPlan: z.object({
        status: z.enum(["TRADE_NOW", "WAIT"]),
        waitType: z.enum([
            "WAIT_OVEREXTENDED",
            "WAIT_NO_NEAR_RISK_POINT",
            "WAIT_NO_BRIGHT_ZONE",
            "WAIT_NEED_RETEST",
            "WAIT_NEED_SWEEP",
        ]).nullable(),
        activationTrigger: z.string(),
        secondaryReference: z.string(),
        invalidationTrigger: z.string(),
        oneSentenceReason: z.string(),
    }),
}).superRefine((response, ctx) => {
    if (response.executionPlan.status === "TRADE_NOW" && response.executionPlan.waitType !== null) {
        ctx.addIssue({
            code: "custom",
            path: ["executionPlan", "waitType"],
            message: "waitType must be null when status is TRADE_NOW",
        });
    }

    if (response.executionPlan.status === "WAIT") {
        if (response.executionPlan.waitType === null) {
            ctx.addIssue({
                code: "custom",
                path: ["executionPlan", "waitType"],
                message: "waitType is required when status is WAIT",
            });
        }

        if (response.lowerTimeframe.canTradeNow !== false) {
            ctx.addIssue({
                code: "custom",
                path: ["lowerTimeframe", "canTradeNow"],
                message: "canTradeNow must be false when status is WAIT",
            });
        }

        if (response.lowerTimeframe.side !== "WAIT") {
            ctx.addIssue({
                code: "custom",
                path: ["lowerTimeframe", "side"],
                message: "side must be WAIT when status is WAIT",
            });
        }

        const nullableTradeFields = [
            "entryPrice",
            "stopLoss",
            "takeProfit1",
            "takeProfit2",
            "rr",
        ] as const;

        for (const field of nullableTradeFields) {
            if (response.lowerTimeframe[field] !== null) {
                ctx.addIssue({
                    code: "custom",
                    path: ["lowerTimeframe", field],
                    message: `${field} must be null when status is WAIT`,
                });
            }
        }
    }
});

export type AiResponse = z.infer<typeof AiResponseSchema>;
export type Signal = "LONG" | "SHORT" | "WAIT";

// ===================== PARSE & VALIDATE =====================

export function parseAndValidateAiResponse(raw: string): AiResponse {
    const extracted = extractJsonFromText(raw);

    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch (e) {
        throw new Error(`AI вернул НЕ валидный JSON: ${e instanceof Error ? e.message : "parse error"}`);
    }

    const result = AiResponseSchema.safeParse(parsed);
    if (!result.success) {
        const errors = result.error.issues
            .map(issue => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ");
        throw new Error(`JSON не соответствует схеме: ${errors}`);
    }

    return result.data;
}

// ===================== TELEGRAM FORMAT =====================

export function formatAiResponseForTelegram(
    response: AiResponse,
    symbol: string,
    entryTf: string = "15m",
    contextTf: string = "1H"
): string {
    const sideEmoji =
        response.lowerTimeframe.side === "LONG"
            ? "🟢"
            : response.lowerTimeframe.side === "SHORT"
                ? "🔴"
                : "⏸️";

    const isTradeNow = response.executionPlan.status === "TRADE_NOW";

    const biasRu: Record<string, string> = {
        BULLISH: "Бычий",
        BEARISH: "Медвежий",
        NEUTRAL: "Нейтральный",
    };

    const marketStateRu: Record<string, string> = {
        TREND: "Тренд",
        RANGE: "Рейндж",
        EXPANSION: "Экспансия",
        DISTRIBUTION: "Распределение",
        ACCUMULATION: "Накопление",
    };

    const trendQualityRu: Record<string, string> = {
        CLEAN: "Чистый",
        CHOPPY: "Рваный",
        OVEREXTENDED: "Перерастянутый",
    };

    const cvdRu: Record<string, string> = {
        CONFIRM: "Подтверждает",
        DIVERGENCE: "Дивергенция",
        FLAT: "Флэт",
    };

    const oiRu: Record<string, string> = {
        BUILDUP: "Набор",
        FLUSH: "Сброс",
        FLAT: "Флэт",
    };

    const fundingRu: Record<string, string> = {
        LONG_CROWDED: "Перегретые лонги",
        SHORT_CROWDED: "Перегретые шорты",
        NEUTRAL: "Нейтрально",
    };

    const priceLocationRu: Record<string, string> = {
        AT_BRIGHT_ZONE: "У яркой зоны",
        BETWEEN_ZONES: "Между зонами",
        EXTENDED_FROM_ZONE: "Далеко от зоны",
    };

    const waitTypeRu: Record<string, string> = {
        WAIT_OVEREXTENDED: "Перерастянутый импульс",
        WAIT_NO_NEAR_RISK_POINT: "Нет близкой точки риска",
        WAIT_NO_BRIGHT_ZONE: "Нет яркой зоны",
        WAIT_NEED_RETEST: "Нужен retest",
        WAIT_NEED_SWEEP: "Нужен sweep",
    };

    const interactionRu: Record<string, string> = {
        APPROACHING_UPPER_ZONE: "Подход к верхней зоне",
        APPROACHING_LOWER_ZONE: "Подход к нижней зоне",
        INSIDE_UPPER_ZONE: "Внутри верхней зоны",
        INSIDE_LOWER_ZONE: "Внутри нижней зоны",
        REJECTED_FROM_UPPER: "Реакция вниз от верхней зоны",
        RECLAIMED_LOWER: "Возврат выше нижней зоны",
        SWEPT_UPPER: "Вынос верхней зоны",
        SWEPT_LOWER: "Вынос нижней зоны",
        BETWEEN_ZONES: "Между зонами",
        NONE: "Нет четкого взаимодействия",
    };

    const triggerRu: Record<string, string> = {
        SWEEP_AND_RECLAIM: "Sweep and reclaim",
        RETEST_HOLD: "Retest and hold",
        REJECTION_FROM_UPPER_ZONE: "Rejection from upper zone",
        ACCEPTANCE_ABOVE_ZONE: "Acceptance above zone",
        ACCEPTANCE_BELOW_ZONE: "Acceptance below zone",
        NO_TRIGGER: "Нет триггера",
    };

    const strengthRu: Record<string, string> = {
        STRONG: "Сильная",
        MEDIUM: "Средняя",
        WEAK: "Слабая",
        NONE: "Нет",
    };

    const sideLabel =
        response.lowerTimeframe.side === "WAIT"
            ? "WAIT"
            : response.lowerTimeframe.side;

    const summaryLine = isTradeNow
        ? `Рынок: <b>${biasRu[response.higherTimeframe.marketBias]}</b> • Вход: <b>разрешён</b> • Trigger: <b>${triggerRu[response.lowerTimeframe.tradeTriggerType]}</b>`
        : `Рынок: <b>${biasRu[response.higherTimeframe.marketBias]}</b> • Цена: <b>${priceLocationRu[response.lowerTimeframe.priceLocation].toLowerCase()}</b> • Вход: <b>запрещён</b>`;

    let text = `${sideEmoji} <b>${symbol} | ${sideLabel}</b>\n`;
    text += `<code>${entryTf} / ${contextTf}</code>\n`;
    text += `${summaryLine}\n\n`;

    if (isTradeNow) {
        text += `📍 <b>Сделка</b>\n`;
        text += `├ Entry: <code>${formatPrice(response.lowerTimeframe.entryPrice)}</code>\n`;
        text += `├ Stop: <code>${formatPrice(response.lowerTimeframe.stopLoss)}</code>\n`;
        text += `├ TP1: <code>${formatPrice(response.lowerTimeframe.takeProfit1)}</code>\n`;
        text += `├ TP2: <code>${formatPrice(response.lowerTimeframe.takeProfit2)}</code>\n`;
        text += `└ R:R: <b>${response.lowerTimeframe.rr ?? "—"}</b>\n`;

        text += `\n⚡ <b>Триггер</b>\n`;
        text += `├ Interaction: ${interactionRu[response.lowerTimeframe.liquidityInteraction]}\n`;
        text += `└ Trigger: ${triggerRu[response.lowerTimeframe.tradeTriggerType]}\n`;

        text += `\n🧠 <b>Почему сейчас</b>\n`;
        text += `${response.executionPlan.oneSentenceReason}\n`;

        text += `\n⚠️ <b>Отмена</b>\n`;
        text += `${response.executionPlan.invalidationTrigger}\n`;

        text += `\n📊 <b>Контекст</b>\n`;
        text += `├ Bias: ${biasRu[response.higherTimeframe.marketBias]}\n`;
        text += `├ Состояние: ${marketStateRu[response.higherTimeframe.marketState]}\n`;
        text += `├ Качество: ${trendQualityRu[response.higherTimeframe.trendQuality]}\n`;
        text += `├ CVD: ${cvdRu[response.higherTimeframe.cvdState]}\n`;
        text += `├ OI: ${oiRu[response.higherTimeframe.oiState]}\n`;
        text += `├ Funding: ${fundingRu[response.higherTimeframe.fundingState]}\n`;
        text += `├ Верхняя зона: ${formatPrice(response.higherTimeframe.nearestBrightLiquidityAbove)} (${strengthRu[response.higherTimeframe.nearestBrightLiquidityAboveStrength]})\n`;
        text += `└ Нижняя зона: ${formatPrice(response.higherTimeframe.nearestBrightLiquidityBelow)} (${strengthRu[response.higherTimeframe.nearestBrightLiquidityBelowStrength]})`;
    } else {
        text += `⏳ <b>Тип WAIT</b>\n`;
        text += `${response.executionPlan.waitType ? waitTypeRu[response.executionPlan.waitType] : "Ожидание"}\n`;

        text += `\n⚡ <b>Состояние триггера</b>\n`;
        text += `├ Interaction: ${interactionRu[response.lowerTimeframe.liquidityInteraction]}\n`;
        text += `└ Trigger: ${triggerRu[response.lowerTimeframe.tradeTriggerType]}\n`;

        text += `\n🧠 <b>Почему нет входа</b>\n`;
        text += `${response.executionPlan.oneSentenceReason}\n`;

        text += `\n👀 <b>Что жду</b>\n`;
        text += `${response.executionPlan.activationTrigger}\n`;

        if (response.executionPlan.secondaryReference?.trim()) {
            text += `\n📎 <b>Фоновый ориентир</b>\n`;
            text += `${response.executionPlan.secondaryReference}\n`;
        }

        text += `\n⚠️ <b>Отмена сценария</b>\n`;
        text += `${response.executionPlan.invalidationTrigger}\n`;

        text += `\n📊 <b>Контекст</b>\n`;
        text += `├ Bias: ${biasRu[response.higherTimeframe.marketBias]}\n`;
        text += `├ Состояние: ${marketStateRu[response.higherTimeframe.marketState]}\n`;
        text += `├ Качество: ${trendQualityRu[response.higherTimeframe.trendQuality]}\n`;
        text += `├ CVD: ${cvdRu[response.higherTimeframe.cvdState]}\n`;
        text += `├ OI: ${oiRu[response.higherTimeframe.oiState]}\n`;
        text += `├ Funding: ${fundingRu[response.higherTimeframe.fundingState]}\n`;
        text += `├ Верхняя зона: ${formatPrice(response.higherTimeframe.nearestBrightLiquidityAbove)} (${strengthRu[response.higherTimeframe.nearestBrightLiquidityAboveStrength]})\n`;
        text += `└ Нижняя зона: ${formatPrice(response.higherTimeframe.nearestBrightLiquidityBelow)} (${strengthRu[response.higherTimeframe.nearestBrightLiquidityBelowStrength]})`;
    }

    return text;
}

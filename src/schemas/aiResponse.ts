import { z } from "zod";

// ===================== AI RESPONSE SCHEMA =====================

export const AiResponseSchema = z.object({
    signal: z.enum(["LONG", "SHORT", "WAIT"]),
    confidence: z.number().min(0).max(100),
    context: z.object({
        timeframe: z.string(),
        marketType: z.enum(["TREND", "RANGE", "ACCUMULATION", "DISTRIBUTION"]),
        direction: z.enum(["LONG", "SHORT", "NONE"]),
        liquidityPools: z.object({
            above: z.array(z.string()),
            below: z.array(z.string()),
        }),
        cvd: z.enum(["CONFIRM", "DIVERGENCE", "NEUTRAL"]),
        openInterest: z.enum(["BUILDUP", "DISTRIBUTION", "STAGNATION"]),
    }),
    entry: z.object({
        timeframe: z.string(),
        allowed: z.boolean(),
        reason: z.string(),
        entry: z.number().nullable(),
        stopLoss: z.number().nullable(),
        takeProfit: z.number().nullable(),
        rr: z.number().nullable(),
    }),
    activationCondition: z.string(),
});

// Inferred TypeScript type from the schema
export type AiResponse = z.infer<typeof AiResponseSchema>;

// Type for signal values
export type Signal = "LONG" | "SHORT" | "WAIT";

// ===================== PARSE & VALIDATE =====================

/**
 * Извлекает JSON из текста ответа AI (может содержать markdown блоки или лишний текст)
 */
function extractJsonFromText(raw: string): string {
    // Пробуем найти JSON в markdown блоке ```json ... ```
    const jsonBlockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        return jsonBlockMatch[1].trim();
    }

    // Пробуем найти JSON в любом блоке ``` ... ```
    const codeBlockMatch = raw.match(/```\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }

    // Пробуем найти JSON объект напрямую
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return jsonMatch[0];
    }

    // Возвращаем как есть
    return raw.trim();
}

/**
 * Парсит и валидирует JSON ответ от AI модели
 * @throws Error если JSON невалиден или не соответствует схеме
 */
export function parseAndValidateAiResponse(raw: string): AiResponse {
    const extracted = extractJsonFromText(raw);

    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch (e) {
        throw new Error(`AI вернул НЕ валидный JSON: ${e instanceof Error ? e.message : 'parse error'}`);
    }

    const result = AiResponseSchema.safeParse(parsed);
    if (!result.success) {
        const errors = result.error.issues.map(issue =>
            `${issue.path.join('.')}: ${issue.message}`
        ).join('; ');
        throw new Error(`JSON не соответствует схеме: ${errors}`);
    }

    return result.data;
}

/**
 * Форматирует AiResponse в читаемый текст для Telegram
 */
export function formatAiResponseForTelegram(response: AiResponse, symbol: string): string {
    const signalEmoji = response.signal === "LONG" ? "🟢" : response.signal === "SHORT" ? "🔴" : "⏸️";
    const marketTypeRu: Record<string, string> = {
        TREND: "ТРЕНД",
        RANGE: "РЕЙНДЖ",
        ACCUMULATION: "НАКОПЛЕНИЕ",
        DISTRIBUTION: "РАСПРЕДЕЛЕНИЕ"
    };
    const directionRu: Record<string, string> = {
        LONG: "ЛОНГ",
        SHORT: "ШОРТ",
        NONE: "НЕТ"
    };
    const cvdRu: Record<string, string> = {
        CONFIRM: "ПОДТВЕРЖДАЕТ",
        DIVERGENCE: "ДИВЕРГЕНЦИЯ",
        NEUTRAL: "НЕЙТРАЛЬНО"
    };
    const oiRu: Record<string, string> = {
        BUILDUP: "НАБОР",
        DISTRIBUTION: "СБРОС",
        STAGNATION: "СТАГНАЦИЯ"
    };

    let text = `${signalEmoji} <b>СИГНАЛ: ${response.signal}</b>\n`;
    text += `🎯 Уверенность: ${response.confidence}%\n\n`;

    text += `📊 <b>КОНТЕКСТ (${response.context.timeframe})</b>\n`;
    text += `├ Тип рынка: ${marketTypeRu[response.context.marketType] || response.context.marketType}\n`;
    text += `├ Направление: ${directionRu[response.context.direction] || response.context.direction}\n`;
    text += `├ CVD: ${cvdRu[response.context.cvd] || response.context.cvd}\n`;
    text += `├ Open Interest: ${oiRu[response.context.openInterest] || response.context.openInterest}\n`;

    if (response.context.liquidityPools.above.length > 0) {
        text += `├ Ликвидность выше: ${response.context.liquidityPools.above.join(', ')}\n`;
    }
    if (response.context.liquidityPools.below.length > 0) {
        text += `└ Ликвидность ниже: ${response.context.liquidityPools.below.join(', ')}\n`;
    }

    text += `\n📍 <b>ВХОД (${response.entry.timeframe})</b>\n`;
    text += `├ Разрешён: ${response.entry.allowed ? "✅ Да" : "❌ Нет"}\n`;
    text += `├ Причина: ${response.entry.reason}\n`;

    if (response.entry.entry !== null) {
        text += `├ Entry: $${response.entry.entry}\n`;
    }
    if (response.entry.stopLoss !== null) {
        text += `├ Stop Loss: $${response.entry.stopLoss}\n`;
    }
    if (response.entry.takeProfit !== null) {
        text += `├ Take Profit: $${response.entry.takeProfit}\n`;
    }
    if (response.entry.rr !== null) {
        text += `└ R:R: ${response.entry.rr}\n`;
    }

    text += `\n⏰ <b>Условие активации:</b>\n${response.activationCondition}`;

    return text;
}

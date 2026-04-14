import * as fs from "fs";
import chalk from "chalk";
import { AiResponse } from "./schemas/aiResponse";
import { CONFIG, KEYS_USAGE_FILE, KeyUsage, STATE_FILE, WAIT_NOTIFICATIONS_FILE, WaitNotificationState } from "./config";

export class StateStore {
    private tradeState: any = { active: false, side: null };
    private keysUsage: KeyUsage[] = [];
    private lastWaitNotifications: Record<string, WaitNotificationState> = {};

    constructor(private readonly config = CONFIG) {
        this.loadState();
        this.loadKeysUsage();
        this.loadWaitNotifications();
        this.checkAndResetKeys();
    }

    getTradeState(): any {
        return this.tradeState;
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

checkAndResetKeys() {
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
    const activeSymbols = this.config.symbols.filter(s => s.isActive).map(s => s.symbol);
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

getAvailableKeyForSymbol(symbol: string): { key: string; apiKey: string } | null {
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
        const keyConfig = this.config.gemini.find(k => k.key === existing.key);
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
    const availableKey = this.config.gemini.find(
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

markKeyAsExceeded(keyName: string) {
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

incrementKeyUsage(symbol: string) {
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

shouldSkipDuplicateWait(symbol: string, aiResponse: AiResponse): boolean {
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

saveStateFromAiResponse(response: AiResponse) {
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
}

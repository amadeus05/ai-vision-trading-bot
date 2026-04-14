import { Input, Telegraf } from "telegraf";
import { AiResponse, formatAiResponseForTelegram } from "./schemas/aiResponse";
import { CONFIG } from "./config";

export class Notifier {
    private readonly tgBot: Telegraf;

    constructor(private readonly config = CONFIG) {
        this.tgBot = new Telegraf(config.tgToken);
    }

    async sendSignal(symbol: string, response: AiResponse, paths: { pathEntry: string, pathContext: string }): Promise<void> {
        const formattedMessage = formatAiResponseForTelegram(response, symbol, this.config.timeframes.entryTf, this.config.timeframes.contextTf);
        if (response.executionPlan.status === "TRADE_NOW") {
            await this.tgBot.telegram.sendPhoto(this.config.tgChatId, Input.fromLocalFile(paths.pathEntry), { caption: "<b>" + symbol + " " + this.config.timeframes.entryTf + "/" + this.config.timeframes.contextTf + " TRADE NOW</b>", parse_mode: "HTML" });
        }
        await this.tgBot.telegram.sendMessage(this.config.tgChatId, formattedMessage, { parse_mode: "HTML" });
    }
}

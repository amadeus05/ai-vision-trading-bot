import chalk from "chalk";
import WebSocket from "ws";
import { CONFIG } from "./config";

export class Scheduler {
    constructor(private readonly config = CONFIG) {}

isWorkingTime(): boolean {
    const now = new Date();
    const currentTimeStr = now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: this.config.workingHours.timezone
    });

    const { start, end } = this.config.workingHours;
    const isWorking = currentTimeStr >= start && currentTimeStr <= end;

    if (!isWorking) {
        console.log(chalk.gray(`😴 Вне рабочего диапазона (${start} - ${end}). Текущее время (Киев): ${currentTimeStr}. Пропуск...`));
    }

    return isWorking;
}

async waitForCandleClose(interval: string): Promise<void> {
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
}

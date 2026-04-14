import { chromium } from "playwright";

async function saveAuth() {
    // Запускаем с видимым окном
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("1. Войдите в аккаунт на открывшейся странице.");
    await page.goto("https://www.coinglass.com/ru/login");

    // Ждем, пока ты сам перейдешь на график после логина
    console.log("2. ПОСЛЕ ЛОГИНА ПЕРЕЙДИ ПО ССЫЛКЕ НА ГРАФИК LEGEND.");
    console.log("3. Когда график полностью прогрузится, ЗАКРОЙ БРАУЗЕР КРЕСТИКОМ.");

    // Ждем закрытия окна
    await new Promise((resolve) => page.on('close', resolve));

    console.log("💾 Сохранение сессии...");
    await context.storageState({ path: "auth.json" });
    console.log("✅ Готово! Теперь запускай бота.");
    
    await browser.close();
}

saveAuth();
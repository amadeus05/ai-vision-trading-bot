# Quant Bot

TypeScript bot for capturing CoinGlass Legend charts, sending screenshots to Gemini for analysis, and posting results to Telegram.

## Requirements

- Node.js 20+
- npm
- Playwright browser dependencies
- CoinGlass account/session
- Telegram bot token and chat id
- Gemini API key(s)

## Setup

Install dependencies:

```powershell
npm install
```

Create a local `.env` file in the project root:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
GEMINI_API_KEY_1=your_gemini_key
GEMINI_API_KEY_2=
GEMINI_API_KEY_3=
GEMINI_API_KEY_4=
GEMINI_API_KEY_5=
GEMINI_API_KEY_6=
GEMINI_API_KEY_7=
```

`.env` is ignored by Git and should not be committed.

## CoinGlass Auth

The bot uses `auth.json` to reuse your browser session for CoinGlass. If CoinGlass shows Login instead of the Legend chart, refresh the session:

```powershell
npm run save-auth
```

Then:

1. Log in to CoinGlass in the opened browser.
2. Open the Legend chart and make sure the chart is visible.
3. Return to the terminal and press Enter.

This saves a fresh `auth.json` in the project root.

`auth.json` and `auth*.json` are ignored by Git because they contain browser cookies/session data.

## Run

Development mode:

```powershell
npm run dev
```

Build TypeScript:

```powershell
npm run build
```

Run compiled output:

```powershell
npm start
```

## Main Config

Most runtime settings are in `src/bot.ts` inside `CONFIG`:

- `browser.debug`: set to `true` to see the Playwright browser.
- `timeframes.entryTf`: lower timeframe used for entry analysis.
- `timeframes.contextTf`: higher timeframe used for market context.
- `symbols`: active trading pairs and CoinGlass Legend URL.
- `kline`: candle interval used for scheduling.
- `runInitialAnalysis`: whether to analyze immediately on startup.
- `workingHours`: local working window for the bot.

## Generated Files

These files/folders are generated locally and ignored by Git:

- `auth.json`, `auth*.json`
- `screenshots/`
- `dist/`
- `keys_usage.json`
- `trade_state.json`
- `src-export.txt`
- `draft/`

## Troubleshooting

If the bot cannot open CoinGlass search:

1. Run `npm run save-auth` and refresh `auth.json`.
2. Set `browser.debug` to `true` in `src/bot.ts`.
3. Run `npm run dev` and check whether the opened page shows the Legend chart or a Login page.

If Playwright finds the search button but cannot click it, the page may be animating or covered by an overlay. The bot already tries normal click, forced click, and DOM click.

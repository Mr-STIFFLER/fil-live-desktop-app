# FIL Live Desktop

This repository contains a desktop application built with [Electron](https://www.electronjs.org/) for tracking Filecoin (FIL) pricing and on‑chain balances.  It displays live ticker data, tracks your position and cost basis, and optionally sends alerts when take‑profit or stop‑loss thresholds are crossed.

## Features

- **Per‑second live price** via the Coinbase Exchange WebSocket with automatic fallback to Kraken WebSocket or REST polling.
- **On‑chain balance refresh** every minute via GLIF/Filfox RPC, with caching to handle intermittent failures.
- **Position tracking** using a configurable cost basis array that automatically computes quantity when only USD and price are provided.
- **P&L, average cost, and deltas** shown in a modern UI, including 1h/24h percentage changes and 24‑hour high/low.
- **Configurable targets:** take‑profit (TP) and stop‑loss (SL) with cooldown‑protected alerts.  Alerts trigger desktop notifications and can post to a Discord webhook.
- **Cross‑platform packaging** using electron‑builder (see [package.json](package.json)).

## Setup

1. **Install Node.js 18+** (see [nodejs.org](https://nodejs.org/)).
2. **Clone this repository**:
   ```bash
   git clone https://github.com/Mr-STIFFLER/fil-live-desktop-app.git
   cd fil-live-desktop-app
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Configure your settings**: open `renderer.js` and update `FIL_ADDRESSES`, `FIL_LOTS`, `TP_PRICE`, `SL_PRICE`, and `ALERT_WEBHOOK` as needed.
5. **Run the app**:
   ```bash
   npm start
   ```

## Packaging

To build a platform‑specific installer, use the scripts defined in `package.json`.  For example:

- **Linux**: `npm run build:linux`
- **Windows**: `npm run build:win`
- **macOS**: `npm run build:mac`

The generated artifacts will be written to the `dist/` folder.  See `.github/workflows/build.yml` for an example GitHub Actions workflow that performs this build on push.

## License

This project is licensed under the MIT License.  See [LICENSE](LICENSE) for details.

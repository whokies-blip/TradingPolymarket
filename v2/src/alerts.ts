import type { Config } from './config';

/** Telegram alerts (optional: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). The same message is sent at most every 10 minutes. */
export function makeAlerts(cfg: Config) {
  const sent = new Map<string, number>();
  return async (msg: string): Promise<void> => {
    console.log(`[alerte] ${msg}`);
    if (!cfg.telegramToken || !cfg.telegramChat) return;
    const now = Date.now();
    if ((sent.get(msg) ?? 0) > now - 600_000) return;
    sent.set(msg, now);
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegramChat, text: `Polymarket MM v2 — ${msg}` }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* an alert must never break the engine */
    }
  };
}

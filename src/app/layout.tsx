import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Polymarket 5 min — BTC & ETH', description: 'Trading automatisé auto-améliorant sur les marchés 5 minutes de Polymarket.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}

import type { NextConfig } from 'next';

const config: NextConfig = {
  // The Polymarket order client is only loaded on the server, on demand.
  serverExternalPackages: ['@polymarket/clob-client'],
};

export default config;

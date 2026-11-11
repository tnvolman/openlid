import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { NearRpcContractClient, UnconfiguredNearClient, type NearContractClient } from './near.js';
import { HttpOneClickClient } from './oneclick.js';
import { JsonStore } from './store.js';

const config = loadConfig();

const store = new JsonStore(config.dataDir);
await store.init();

let near: NearContractClient;
if (config.contractId && config.agentAccountId && config.agentKeyFile) {
  // Agent key: restricted function-call key for request_payout only (verified before first use).
  near = new NearRpcContractClient({
    network: config.network,
    contractId: config.contractId,
    agentAccountId: config.agentAccountId,
    agentKeyFile: config.agentKeyFile,
    ownerAccountId: config.ownerAccountId,
    ownerKeyFile: config.ownerKeyFile,
  });
} else {
  near = new UnconfiguredNearClient(
    'NEAR is not configured: set OPENLID_CONTRACT_ID, OPENLID_AGENT_ACCOUNT_ID and OPENLID_AGENT_KEY_FILE',
  );
}

const app = createApp({
  store,
  near,
  oneClick: new HttpOneClickClient({ baseUrl: config.oneClickBaseUrl, apiKey: config.oneClickApiKey }),
  contractId: config.contractId,
  usdcTokenId: config.usdcTokenId,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  // Log only non-secret settings.
  console.log(
    `openlid api listening on http://${info.address}:${info.port} (network=${config.network}, data=${config.dataDir}, ` +
      `1click=${config.oneClickBaseUrl}, 1click key ${config.oneClickApiKey ? 'set' : 'not set'}, ` +
      `near ${near instanceof UnconfiguredNearClient ? 'not configured' : 'configured'})`,
  );
});

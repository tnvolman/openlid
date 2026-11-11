import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import {
  NearRpcContractClient,
  NearTestFtSettlement,
  UnconfiguredNearClient,
  UnconfiguredSettlement,
  resolveKeyFile,
  type NearContractClient,
  type TestnetSettlement,
} from './near.js';
import { createDryRunStubFetch, DRY_RUN_STUB_BASE_URL, HttpOneClickClient } from './oneclick.js';
import { JsonStore } from './store.js';

const config = loadConfig();

const store = new JsonStore(config.dataDir);
await store.init();

// Key files come only from env paths or OPENLID_DEMO_KEYS_DIR/<accountId>.json. Only paths are ever logged.
const agentKeyFile = resolveKeyFile(config.agentKeyFile, config.demoKeysDir, config.agentAccountId);
const ownerKeyFile = resolveKeyFile(config.ownerKeyFile, config.demoKeysDir, config.ownerAccountId);

let near: NearContractClient;
if (config.contractId && config.agentAccountId && agentKeyFile) {
  // Agent key: restricted function-call key for request_payout only (verified on-chain before first use).
  near = new NearRpcContractClient({
    network: config.network,
    contractId: config.contractId,
    agentAccountId: config.agentAccountId,
    agentKeyFile,
    ownerAccountId: config.ownerAccountId,
    ownerKeyFile,
    usdcTokenId: config.usdcTokenId,
  });
} else {
  near = new UnconfiguredNearClient(
    'NEAR is not configured: set OPENLID_CONTRACT_ID, OPENLID_AGENT_ACCOUNT_ID and OPENLID_AGENT_KEY_FILE (or OPENLID_DEMO_KEYS_DIR)',
  );
}

// Simulated settlement: the owner (OPENLID_OWNER_ACCOUNT_ID; test FT owner AND treasury owner) mints tUSDC into
// the treasury contract, then records it in the gift's fund with the treasury's owner-only credit_fund.
let settlement: TestnetSettlement;
if (config.network === 'testnet' && config.contractId && config.usdcTokenId && config.ownerAccountId && ownerKeyFile) {
  settlement = new NearTestFtSettlement({
    network: config.network,
    tokenId: config.usdcTokenId,
    treasuryId: config.contractId,
    minterAccountId: config.ownerAccountId,
    minterKeyFile: ownerKeyFile,
  });
} else {
  settlement = new UnconfiguredSettlement(
    'simulated settlement needs OPENLID_NETWORK=testnet, OPENLID_CONTRACT_ID, OPENLID_USDC_TOKEN_ID, ' +
      'OPENLID_OWNER_ACCOUNT_ID and an owner key file (OPENLID_OWNER_KEY_FILE or OPENLID_DEMO_KEYS_DIR)',
  );
}

// 1Click: dry-run quotes only. Without ONECLICK_API_KEY, never touch the live (paid/partner) API: use the
// local dry-run-shaped stub through the same client.
const oneClickLive = Boolean(config.oneClickApiKey);
const oneClick = oneClickLive
  ? new HttpOneClickClient({ baseUrl: config.oneClickBaseUrl, apiKey: config.oneClickApiKey })
  : new HttpOneClickClient({ baseUrl: DRY_RUN_STUB_BASE_URL, fetch: createDryRunStubFetch() });

const app = createApp({
  store,
  near,
  settlement,
  network: config.network,
  oneClick,
  contractId: config.contractId,
  usdcTokenId: config.usdcTokenId,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  // Log only non-secret settings: no keys, no key file contents.
  console.log(
    `openlid api listening on http://${info.address}:${info.port} (network=${config.network}, data=${config.dataDir}, ` +
      `1click=${oneClickLive ? `${config.oneClickBaseUrl} dry-run` : 'local dry-run stub (no API key, no network)'}, ` +
      `near ${near instanceof UnconfiguredNearClient ? 'not configured' : 'configured'}, ` +
      `settlement ${settlement instanceof UnconfiguredSettlement ? 'not configured' : 'test FT mint'})`,
  );
  console.log(
    'NOTE: the cross-chain leg is a 1Click dry-run quote plus a simulated settlement on NEAR testnet. ' +
      'No deposit is ever sent. Receipts: demo, not a tax document.',
  );
});

import { resolve } from 'node:path';

/** Runtime config from env. Only names are documented; values (and key files) stay off-repo. */
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  network: string;
  /** NEAR JSON-RPC URL (OPENLID_NEAR_RPC_URL). Unset: `defaultRpcUrl(network)` in near.ts. */
  rpcUrl?: string;
  contractId?: string;
  usdcTokenId?: string;
  ownerAccountId?: string;
  ownerKeyFile?: string;
  agentAccountId?: string;
  agentKeyFile?: string;
  oneClickBaseUrl: string;
  oneClickApiKey?: string;
  /** Where the testnet demo writes generated keys (`<dir>/<accountId>.json`). Paths only; never read into logs. */
  demoKeysDir?: string;
  /**
   * Shared secret the treasurer page sends as `X-OpenLid-Approval` on approve/reject (OPENLID_APPROVAL_SECRET).
   * Unset: approve/reject fail closed with 503; every other route still works. Never logged or returned.
   */
  approvalSecret?: string;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = (opt(env, 'OPENLID_NETWORK') ?? 'testnet').toLowerCase();
  if (network === 'mainnet') throw new Error('OPENLID_NETWORK=mainnet is not allowed for this demo');
  const dryRun = opt(env, 'ONECLICK_DRY_RUN');
  if (dryRun !== undefined && dryRun.toLowerCase() !== 'true') {
    throw new Error('ONECLICK_DRY_RUN must be true: this build only requests 1Click dry-run quotes');
  }
  const demoKeysDir = opt(env, 'OPENLID_DEMO_KEYS_DIR');
  return {
    host: opt(env, 'OPENLID_API_HOST') ?? '127.0.0.1',
    port: Number(opt(env, 'OPENLID_API_PORT') ?? 8787),
    dataDir: resolve(opt(env, 'OPENLID_DATA_DIR') ?? './data'),
    network,
    rpcUrl: opt(env, 'OPENLID_NEAR_RPC_URL'),
    contractId: opt(env, 'OPENLID_CONTRACT_ID'),
    usdcTokenId: opt(env, 'OPENLID_USDC_TOKEN_ID'),
    ownerAccountId: opt(env, 'OPENLID_OWNER_ACCOUNT_ID'),
    ownerKeyFile: opt(env, 'OPENLID_OWNER_KEY_FILE'),
    agentAccountId: opt(env, 'OPENLID_AGENT_ACCOUNT_ID'),
    agentKeyFile: opt(env, 'OPENLID_AGENT_KEY_FILE'),
    oneClickBaseUrl: opt(env, 'ONECLICK_BASE_URL') ?? 'https://1click.chaindefuser.com',
    oneClickApiKey: opt(env, 'ONECLICK_API_KEY'),
    demoKeysDir: demoKeysDir ? resolve(demoKeysDir) : undefined,
    approvalSecret: opt(env, 'OPENLID_APPROVAL_SECRET'),
  };
}

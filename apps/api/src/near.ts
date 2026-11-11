import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from 'near-api-js';
import type { HoldStatus, HoldView, PayoutView } from './types.js';

export interface RequestPayoutArgs {
  vendor: string;
  amount: string;
  billId: string;
  memo: string;
}

export interface RequestPayoutResult {
  status: 'paid' | 'held';
}

/**
 * Treasury contract surface used by the API.
 *
 * `requestPayout` is signed by the agent's restricted function-call key (contract + `request_payout` only).
 * `approveHold` / `rejectHold` are owner (treasurer) actions and never use the agent key.
 */
export interface NearContractClient {
  requestPayout(args: RequestPayoutArgs): Promise<RequestPayoutResult>;
  getPayout(billId: string): Promise<PayoutView | null>;
  getHold(billId: string): Promise<HoldView | null>;
  listHolds(status?: HoldStatus): Promise<HoldView[]>;
  approveHold(billId: string): Promise<void>;
  rejectHold(billId: string): Promise<void>;
  /** Live USDC balance held by the treasury contract (smallest units), or null if unknown. */
  treasuryBalance?(): Promise<string | null>;
}

/** The contract panicked (unauthorized, unknown vendor, cap exceeded, duplicate bill, ...). Maps to 4xx. */
export class ContractRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractRejectedError';
  }
}

/** NEAR signing is not configured for this action. Maps to 503. */
export class NearUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NearUnavailableError';
  }
}

const PANIC_RE = /Smart contract panicked:\s*(.*)/s;

/** Turn a near-api-js failure into ContractRejectedError when it is a contract panic / execution error. */
export function classifyNearError(err: unknown): Error {
  const e = err as { message?: unknown; type?: unknown; name?: unknown };
  const msg = typeof e?.message === 'string' ? e.message : String(err);
  const m = PANIC_RE.exec(msg);
  if (m) return new ContractRejectedError(m[1]!.trim().split('\n')[0]!);
  const kind = `${String(e?.type ?? '')} ${String(e?.name ?? '')}`;
  if (/FunctionCall|ExecutionError|ActionError|MethodNotFound/i.test(kind)) {
    return new ContractRejectedError(msg);
  }
  return err instanceof Error ? err : new Error(msg);
}

/**
 * Reads a key file without ever logging or echoing its contents (errors name the problem, never the text).
 * Accepts either a NEAR CLI credentials JSON (`{"account_id","public_key","private_key"}`) or a file
 * containing only the `ed25519:...` key string.
 */
export async function loadKeyFromFile(path: string): Promise<KeyPairString> {
  let raw: string;
  try {
    raw = (await readFile(path, 'utf8')).trim();
  } catch (err) {
    throw new NearUnavailableError(`cannot read key file at ${path} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let key: string = raw;
  if (raw.startsWith('{')) {
    let parsed: { private_key?: unknown; secret_key?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // JSON.parse messages can quote the input; never surface them.
      throw new NearUnavailableError(`key file at ${path} is not valid JSON`);
    }
    const k = parsed.private_key ?? parsed.secret_key;
    if (typeof k !== 'string') throw new NearUnavailableError(`key file at ${path} has no private_key field`);
    key = k;
  }
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(key)) {
    throw new NearUnavailableError(`key file at ${path} does not contain a NEAR key string`);
  }
  return key as KeyPairString;
}

/** Builds a signer from a key file. Key-parsing errors are replaced so they cannot carry key text. */
async function signerFromFile(path: string): Promise<{ signer: KeyPairSigner; publicKey: string }> {
  const key = await loadKeyFromFile(path);
  try {
    return { signer: KeyPairSigner.fromSecretKey(key), publicKey: KeyPair.fromString(key).getPublicKey().toString() };
  } catch {
    throw new NearUnavailableError(`key file at ${path} holds a malformed key`);
  }
}

/**
 * Key file path for an account: the explicit env path if set, otherwise `<OPENLID_DEMO_KEYS_DIR>/<accountId>.json`
 * (where the testnet demo writes keys it generates). Returns undefined when neither is available.
 */
export function resolveKeyFile(explicit: string | undefined, demoKeysDir: string | undefined, accountId: string | undefined): string | undefined {
  if (explicit) return explicit;
  if (demoKeysDir && accountId) return join(demoKeysDir, `${accountId}.json`);
  return undefined;
}

export interface NearRpcClientOptions {
  network: string;
  rpcUrl?: string;
  contractId: string;
  agentAccountId: string;
  agentKeyFile: string;
  ownerAccountId?: string;
  ownerKeyFile?: string;
  /** USDC (or test FT) token contract, for the live treasury balance. */
  usdcTokenId?: string;
}

export function defaultRpcUrl(network: string): string {
  if (network === 'testnet') return 'https://rpc.testnet.near.org';
  if (network === 'local' || network === 'sandbox') return 'http://127.0.0.1:3030';
  throw new Error(`OPENLID_NETWORK=${network} is not supported by this demo (use testnet or local)`);
}

const GAS = 100_000_000_000_000n; // 100 TGas, enough for the USDC ft_transfer cross-contract call

/**
 * Production client. The agent key MUST be a function-call access key restricted to
 * `receiver_id = OPENLID_CONTRACT_ID` and `method_names = ["request_payout"]`; this is
 * verified on-chain before first use and a full-access key is refused.
 */
export class NearRpcContractClient implements NearContractClient {
  private readonly provider: JsonRpcProvider;
  private agent?: Promise<Account>;
  private owner?: Promise<Account>;

  constructor(private readonly opts: NearRpcClientOptions) {
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl ?? defaultRpcUrl(opts.network) });
  }

  private agentAccount(): Promise<Account> {
    this.agent ??= (async () => {
      const { signer, publicKey } = await signerFromFile(this.opts.agentKeyFile);
      await this.assertRestrictedAgentKey(publicKey);
      return new Account(this.opts.agentAccountId, this.provider, signer);
    })();
    this.agent.catch(() => (this.agent = undefined));
    return this.agent;
  }

  private ownerAccount(): Promise<Account> {
    const { ownerAccountId, ownerKeyFile } = this.opts;
    if (!ownerAccountId || !ownerKeyFile) {
      return Promise.reject(
        new NearUnavailableError(
          'owner signing is not configured on this server; the treasurer approves/rejects holds with their own wallet',
        ),
      );
    }
    this.owner ??= (async () => {
      const { signer } = await signerFromFile(ownerKeyFile);
      return new Account(ownerAccountId, this.provider, signer);
    })();
    this.owner.catch(() => (this.owner = undefined));
    return this.owner;
  }

  private async assertRestrictedAgentKey(publicKey: string): Promise<void> {
    const ak = (await this.provider.viewAccessKey({ accountId: this.opts.agentAccountId, publicKey })) as {
      permission: unknown;
    };
    const perm = ak.permission as
      | 'FullAccess'
      | { FunctionCall?: { receiver_id?: string; method_names?: string[] }; FullAccess?: unknown };
    if (perm === 'FullAccess' || (typeof perm === 'object' && perm && 'FullAccess' in perm)) {
      throw new NearUnavailableError('refusing to use a full-access key as the agent key; issue a function-call key');
    }
    const fc = typeof perm === 'object' && perm ? perm.FunctionCall : undefined;
    const ok =
      fc &&
      fc.receiver_id === this.opts.contractId &&
      Array.isArray(fc.method_names) &&
      fc.method_names.length === 1 &&
      fc.method_names[0] === 'request_payout';
    if (!ok) {
      throw new NearUnavailableError(
        'agent key must be a function-call key for OPENLID_CONTRACT_ID limited to method request_payout',
      );
    }
  }

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return (await this.provider.callFunction({ contractId: this.opts.contractId, method, args })) as T;
    } catch (err) {
      throw classifyNearError(err);
    }
  }

  async requestPayout(args: RequestPayoutArgs): Promise<RequestPayoutResult> {
    const account = await this.agentAccount();
    try {
      await account.callFunction({
        contractId: this.opts.contractId,
        methodName: 'request_payout',
        args: { vendor: args.vendor, amount: args.amount, bill_id: args.billId, memo: args.memo },
        gas: GAS,
      });
    } catch (err) {
      throw classifyNearError(err);
    }
    // The contract records either a payout (paid) or a hold (held); read it back rather than guess.
    if (await this.getPayout(args.billId)) return { status: 'paid' };
    const hold = await this.getHold(args.billId);
    if (hold?.status === 'held') return { status: 'held' };
    // The function-call "succeeded" but the ft_transfer callback rolled the
    // payout back (commonly: treasury token balance too low). Surface as a
    // contract rejection, not a 500.
    throw new ContractRejectedError(
      `ft_transfer failed and the payout was rolled back for ${args.billId} (treasury may lack token balance)`,
    );
  }

  getPayout(billId: string): Promise<PayoutView | null> {
    return this.view<PayoutView | null>('get_payout', { bill_id: billId }).then((v) => v ?? null);
  }

  getHold(billId: string): Promise<HoldView | null> {
    return this.view<HoldView | null>('get_hold', { bill_id: billId }).then((v) => v ?? null);
  }

  async treasuryBalance(): Promise<string | null> {
    if (!this.opts.usdcTokenId) return null;
    try {
      const v = (await this.provider.callFunction({
        contractId: this.opts.usdcTokenId,
        method: 'ft_balance_of',
        args: { account_id: this.opts.contractId },
      })) as string | null;
      return typeof v === 'string' ? v : null;
    } catch (err) {
      throw classifyNearError(err);
    }
  }

  listHolds(status?: HoldStatus): Promise<HoldView[]> {
    return this.view<HoldView[] | null>('list_holds', { status: status ?? null }).then((v) => v ?? []);
  }

  private async ownerCall(methodName: string, billId: string): Promise<void> {
    const account = await this.ownerAccount();
    try {
      await account.callFunction({
        contractId: this.opts.contractId,
        methodName,
        args: { bill_id: billId },
        gas: GAS,
      });
    } catch (err) {
      throw classifyNearError(err);
    }
  }

  approveHold(billId: string): Promise<void> {
    return this.ownerCall('approve_hold', billId);
  }

  rejectHold(billId: string): Promise<void> {
    return this.ownerCall('reject_hold', billId);
  }
}

/** Used when NEAR env is not set: gift endpoints still work, payout endpoints return 503. */
export class UnconfiguredNearClient implements NearContractClient {
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new NearUnavailableError(this.reason);
  }
  async requestPayout(): Promise<RequestPayoutResult> {
    this.fail();
  }
  async getPayout(): Promise<PayoutView | null> {
    this.fail();
  }
  async getHold(): Promise<HoldView | null> {
    this.fail();
  }
  async listHolds(): Promise<HoldView[]> {
    this.fail();
  }
  async approveHold(): Promise<void> {
    this.fail();
  }
  async rejectHold(): Promise<void> {
    this.fail();
  }
}

/**
 * Simulated cross-chain settlement for the testnet demo. Credits the treasury contract with the test FT
 * (`contracts/test-ft`, symbol tUSDC) instead of receiving a real 1Click swap.
 */
export interface TestnetSettlement {
  creditTreasury(args: { giftId: string; amount: string }): Promise<{ txHash: string | null }>;
}

export interface NearTestFtSettlementOptions {
  network: string;
  rpcUrl?: string;
  /** Test FT contract (OPENLID_USDC_TOKEN_ID). */
  tokenId: string;
  /** Treasury contract that receives the minted test FT (OPENLID_CONTRACT_ID). */
  treasuryId: string;
  /** Test FT owner allowed to call `mint` (OPENLID_OWNER_ACCOUNT_ID in the demo). */
  minterAccountId: string;
  minterKeyFile: string;
}

/** Calls `mint(account, amount)` on the test FT, signed by its owner. Testnet only. */
export class NearTestFtSettlement implements TestnetSettlement {
  private readonly provider: JsonRpcProvider;
  private minter?: Promise<Account>;

  constructor(private readonly opts: NearTestFtSettlementOptions) {
    if (opts.network !== 'testnet') throw new Error('test FT settlement runs on NEAR testnet only');
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl ?? defaultRpcUrl(opts.network) });
  }

  private account(): Promise<Account> {
    this.minter ??= signerFromFile(this.opts.minterKeyFile).then(
      ({ signer }) => new Account(this.opts.minterAccountId, this.provider, signer),
    );
    this.minter.catch(() => (this.minter = undefined));
    return this.minter;
  }

  async creditTreasury({ amount }: { giftId: string; amount: string }): Promise<{ txHash: string | null }> {
    const account = await this.account();
    try {
      const res = (await account.callFunctionRaw({
        contractId: this.opts.tokenId,
        methodName: 'mint',
        args: { account: this.opts.treasuryId, amount },
        gas: GAS,
      })) as { transaction_outcome?: { id?: string }; transaction?: { hash?: string } };
      return { txHash: res.transaction_outcome?.id ?? res.transaction?.hash ?? null };
    } catch (err) {
      throw classifyNearError(err);
    }
  }
}

/** Used when the test FT or its minter is not configured: simulate-settlement returns 503. */
export class UnconfiguredSettlement implements TestnetSettlement {
  constructor(private readonly reason: string) {}
  async creditTreasury(): Promise<{ txHash: string | null }> {
    throw new NearUnavailableError(this.reason);
  }
}

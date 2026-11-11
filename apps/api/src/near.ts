import { readFile } from 'node:fs/promises';
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
 * Reads a key file without ever logging its contents. Accepts either a NEAR CLI credentials JSON
 * (`{"account_id","public_key","private_key"}`) or a file containing only the `ed25519:...` key string.
 */
export async function loadKeyFromFile(path: string): Promise<KeyPairString> {
  const raw = (await readFile(path, 'utf8')).trim();
  let key: string = raw;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { private_key?: unknown; secret_key?: unknown };
    const k = parsed.private_key ?? parsed.secret_key;
    if (typeof k !== 'string') throw new Error('key file JSON has no private_key field');
    key = k;
  }
  if (!/^(ed25519|secp256k1):/.test(key)) throw new Error('key file does not contain a NEAR key string');
  return key as KeyPairString;
}

export interface NearRpcClientOptions {
  network: string;
  rpcUrl?: string;
  contractId: string;
  agentAccountId: string;
  agentKeyFile: string;
  ownerAccountId?: string;
  ownerKeyFile?: string;
}

function defaultRpcUrl(network: string): string {
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
      const key = await loadKeyFromFile(this.opts.agentKeyFile);
      await this.assertRestrictedAgentKey(key);
      return new Account(this.opts.agentAccountId, this.provider, KeyPairSigner.fromSecretKey(key));
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
      const key = await loadKeyFromFile(ownerKeyFile);
      return new Account(ownerAccountId, this.provider, KeyPairSigner.fromSecretKey(key));
    })();
    this.owner.catch(() => (this.owner = undefined));
    return this.owner;
  }

  private async assertRestrictedAgentKey(key: KeyPairString): Promise<void> {
    const publicKey = KeyPair.fromString(key).getPublicKey().toString();
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
    throw new Error(`request_payout for ${args.billId} succeeded but no payout or hold was found`);
  }

  getPayout(billId: string): Promise<PayoutView | null> {
    return this.view<PayoutView | null>('get_payout', { bill_id: billId }).then((v) => v ?? null);
  }

  getHold(billId: string): Promise<HoldView | null> {
    return this.view<HoldView | null>('get_hold', { bill_id: billId }).then((v) => v ?? null);
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

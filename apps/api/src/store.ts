import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GiftRecord, PayoutRecord } from './types.js';

export class DuplicateDepositAddressError extends Error {
  constructor(readonly depositAddress: string) {
    super('deposit address is already assigned to another gift; refusing to reuse it');
    this.name = 'DuplicateDepositAddressError';
  }
}

export class DuplicateBillIdError extends Error {
  constructor(readonly billId: string) {
    super(`billId ${billId} was already submitted`);
    this.name = 'DuplicateBillIdError';
  }
}

interface Data {
  gifts: GiftRecord[];
  payouts: PayoutRecord[];
}

/** Deposit addresses are compared case-insensitively so an EVM address in a different case still counts as reuse. */
function addrKey(addr: string): string {
  return addr.trim().toLowerCase();
}

/**
 * Small JSON-file store under OPENLID_DATA_DIR. Writes are serialized and atomic (write tmp + rename).
 * Fine for a single API process; not meant for multi-process use.
 */
export class JsonStore {
  private data: Data = { gifts: [], payouts: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private readonly dir: string) {}

  private get giftsFile() {
    return join(this.dir, 'gifts.json');
  }
  private get payoutsFile() {
    return join(this.dir, 'payouts.json');
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    this.data.gifts = await readJson<GiftRecord[]>(this.giftsFile, []);
    this.data.payouts = await readJson<PayoutRecord[]>(this.payoutsFile, []);
    this.loaded = true;
  }

  /** Run fn exclusively, then persist. */
  private exclusive<T>(fn: () => T, files: Array<'gifts' | 'payouts'>): Promise<T> {
    const run = this.queue.then(async () => {
      const result = fn();
      for (const f of files) {
        if (f === 'gifts') await writeJson(this.giftsFile, this.data.gifts);
        else await writeJson(this.payoutsFile, this.data.payouts);
      }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  listGifts(): GiftRecord[] {
    return [...this.data.gifts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  getGift(id: string): GiftRecord | undefined {
    return this.data.gifts.find((g) => g.id === id);
  }

  findGiftByDepositAddress(addr: string): GiftRecord | undefined {
    const k = addrKey(addr);
    return this.data.gifts.find((g) => addrKey(g.depositAddress) === k);
  }

  /** Inserts a gift. Rejects if any existing gift already uses the same deposit address. */
  insertGift(gift: GiftRecord): Promise<GiftRecord> {
    return this.exclusive(() => {
      if (this.findGiftByDepositAddress(gift.depositAddress)) {
        throw new DuplicateDepositAddressError(gift.depositAddress);
      }
      this.data.gifts.push(gift);
      return gift;
    }, ['gifts']);
  }

  /** Updates exactly one gift, located by id. Never touches other gifts. */
  updateGift(id: string, patch: Partial<Omit<GiftRecord, 'id' | 'depositAddress'>>): Promise<GiftRecord> {
    return this.exclusive(() => {
      const idx = this.data.gifts.findIndex((g) => g.id === id);
      if (idx < 0) throw new Error(`gift ${id} not found`);
      const next = { ...this.data.gifts[idx]!, ...patch };
      this.data.gifts[idx] = next;
      return next;
    }, ['gifts']);
  }

  listPayouts(): PayoutRecord[] {
    return [...this.data.payouts];
  }

  getPayout(billId: string): PayoutRecord | undefined {
    return this.data.payouts.find((p) => p.billId === billId);
  }

  insertPayout(p: PayoutRecord): Promise<PayoutRecord> {
    return this.exclusive(() => {
      if (this.getPayout(p.billId)) throw new DuplicateBillIdError(p.billId);
      this.data.payouts.push(p);
      return p;
    }, ['payouts']);
  }

  upsertPayout(p: PayoutRecord): Promise<PayoutRecord> {
    return this.exclusive(() => {
      const idx = this.data.payouts.findIndex((x) => x.billId === p.billId);
      if (idx < 0) this.data.payouts.push(p);
      else this.data.payouts[idx] = p;
      return p;
    }, ['payouts']);
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

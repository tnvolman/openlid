import { ONECLICK_STATUSES, type OneClickStatus } from './types.js';

/** Request body for 1Click `POST /v0/quote` (https://docs.near-intents.org). */
export interface OneClickQuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
}

export interface OneClickQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountOut: string;
  minAmountOut?: string;
  deadline?: string;
}

export interface OneClickQuoteResponse {
  correlationId: string;
  signature: string;
  timestamp: string;
  quote: OneClickQuote;
}

export interface OneClickStatusResponse {
  status: OneClickStatus;
  updatedAt?: string;
  quoteResponse?: { quote?: { depositAddress?: string } };
  swapDetails?: { amountOut?: string; amountIn?: string };
}

export interface OneClickClient {
  quote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse>;
  status(depositAddress: string, depositMemo?: string | null): Promise<OneClickStatusResponse>;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'OneClickError';
  }
}

export interface HttpOneClickOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Production 1Click client. Tests inject `fetch` to mock HTTP. */
export class HttpOneClickClient implements OneClickClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpOneClickOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey || undefined;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h['X-API-Key'] = this.apiKey;
    return h;
  }

  private async send(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new OneClickError(`1Click request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // fall through with undefined body
    }
    if (!res.ok) {
      const msg =
        body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : res.statusText;
      throw new OneClickError(`1Click responded ${res.status}: ${msg}`, res.status);
    }
    if (body === undefined) throw new OneClickError('1Click returned a non-JSON response');
    return body;
  }

  async quote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
    const body = await this.send(`${this.baseUrl}/v0/quote`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(req),
    });
    return parseQuoteResponse(body);
  }

  async status(depositAddress: string, depositMemo?: string | null): Promise<OneClickStatusResponse> {
    const qs = new URLSearchParams({ depositAddress });
    if (depositMemo) qs.set('depositMemo', depositMemo);
    const body = await this.send(`${this.baseUrl}/v0/status?${qs.toString()}`, {
      method: 'GET',
      headers: this.headers(false),
    });
    return parseStatusResponse(body);
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return undefined;
}

export function parseQuoteResponse(body: unknown): OneClickQuoteResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  const q = (b.quote ?? {}) as Record<string, unknown>;
  const amountIn = str(q.amountIn);
  const amountOut = str(q.amountOut);
  if (!amountIn || !amountOut) throw new OneClickError('1Click quote response missing amountIn/amountOut');
  return {
    correlationId: str(b.correlationId) ?? '',
    signature: str(b.signature) ?? '',
    timestamp: str(b.timestamp) ?? '',
    quote: {
      depositAddress: str(q.depositAddress),
      depositMemo: str(q.depositMemo),
      amountIn,
      amountOut,
      minAmountOut: str(q.minAmountOut),
      deadline: str(q.deadline),
    },
  };
}

export function parseStatusResponse(body: unknown): OneClickStatusResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  const status = b.status;
  if (typeof status !== 'string' || !(ONECLICK_STATUSES as readonly string[]).includes(status)) {
    throw new OneClickError(`1Click returned unknown status: ${JSON.stringify(status)}`);
  }
  const qr = b.quoteResponse as Record<string, unknown> | undefined;
  const q = qr?.quote as Record<string, unknown> | undefined;
  const sd = b.swapDetails as Record<string, unknown> | undefined;
  return {
    status: status as OneClickStatus,
    updatedAt: str(b.updatedAt),
    quoteResponse: q ? { quote: { depositAddress: str(q.depositAddress) } } : undefined,
    swapDetails: sd ? { amountIn: str(sd.amountIn), amountOut: str(sd.amountOut) } : undefined,
  };
}

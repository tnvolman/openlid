#!/usr/bin/env node
// OpenLid per-fund refusal proof. NEAR TESTNET ONLY, test tokens only.
//
// Run after setup.mjs. Reads account ids and key-file PATHS from $OPENLID_DEMO_KEYS_DIR/demo.env
// (default .demo-keys/). Prints account ids, amounts, contract messages and tx hashes only.
// Key material is never printed.
//
// 1. Owner mints 100 tUSDC (test FT) to the treasury and credits it to the missions fund.
//    The building fund is left at 0.
// 2. Agent (function-call key, request_payout only) asks for a 50 tUSDC bill tagged `building`.
//    The contract refuses it with "insufficient fund balance".
// 3. Agent asks for a 40 tUSDC bill tagged `missions`, which the contract pays.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEYS_DIR = resolve(ROOT, process.env.OPENLID_DEMO_KEYS_DIR || ".demo-keys");
const RPC = (process.env.OPENLID_NEAR_RPC_URL || "").trim() || "https://rpc.testnet.fastnear.com";
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const GAS = 100_000_000_000_000n;

const redact = (s) => String(s).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, "ed25519:<redacted>");
const log = (...a) => console.log(redact(a.join(" ")));
const fail = (msg) => {
  console.error(redact(`prove-fund-refusal: ${msg}`));
  process.exit(1);
};

if ((process.env.OPENLID_NETWORK || "testnet").toLowerCase() !== "testnet") fail("testnet only");
const provider = new JsonRpcProvider({ url: RPC });
const status = await provider.viewNodeStatus();
if (status.chain_id !== "testnet") fail(`RPC reports chain_id=${status.chain_id}, not testnet`);

const env = Object.fromEntries(
  readFileSync(join(KEYS_DIR, "demo.env"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
if (env.DEMO_CONTRACTS_DEPLOYED !== "1") fail("demo.env says the contracts are not deployed; run setup.mjs first");

const accountFromFile = (id, file) => {
  const k = JSON.parse(readFileSync(file, "utf8")).private_key;
  return new Account(id, provider, new KeyPairSigner(KeyPair.fromString(k)));
};
const owner = accountFromFile(env.OPENLID_OWNER_ACCOUNT_ID, env.OPENLID_OWNER_KEY_FILE);
const agent = accountFromFile(env.OPENLID_AGENT_ACCOUNT_ID, env.OPENLID_AGENT_KEY_FILE);
const treasury = env.OPENLID_CONTRACT_ID;
const token = env.OPENLID_USDC_TOKEN_ID;
const vendor = env.DEMO_VENDOR;

const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

/** Sends one function call and returns { hash, ok, message } without throwing on a contract panic. */
async function send(acct, receiverId, method, args) {
  const r = await acct.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, GAS, 0n)],
    throwOnFailure: false,
  });
  const hash = r.transaction_outcome?.id ?? r.transaction?.hash;
  const failure = r.status?.Failure ?? r.receipts_outcome?.find((o) => o.outcome.status?.Failure)?.outcome.status.Failure;
  const ok = !failure;
  const exec = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  const message = ok ? "success" : exec ?? JSON.stringify(failure);
  log(`${acct.accountId} -> ${receiverId}.${method}: ${ok ? "SUCCESS" : "FAILED"} ${EXPLORER}${hash}`);
  if (!ok) log(`  contract error: ${message}`);
  return { hash, ok, message };
}

const ledger = async (label) => {
  const rows = await view(treasury, "get_fund_ledger");
  log(`${label} get_fund_ledger:`);
  for (const f of rows) log(`  ${f.fund}: received=${f.received} paid=${f.paid} held=${f.held} available=${f.available}`);
};

const tag = Date.now().toString(36);
const MISSIONS_CREDIT = "100000000"; // 100 tUSDC
const BUILDING_BILL = "50000000"; // 50 tUSDC
const MISSIONS_BILL = "40000000"; // 40 tUSDC

log(`network testnet, treasury ${treasury}, token ${token}, owner ${owner.accountId}, agent ${agent.accountId}, vendor ${vendor}`);
await ledger("before");

const mint = await send(owner, token, "mint", { account: treasury, amount: MISSIONS_CREDIT });
if (!mint.ok) fail("mint failed");
const credit = await send(owner, treasury, "credit_fund", { fund: "missions", amount: MISSIONS_CREDIT, gift_id: `proof-${tag}-gift` });
if (!credit.ok) fail("credit_fund failed");
await ledger("after crediting missions");

const refused = await send(agent, treasury, "request_payout", {
  vendor,
  amount: BUILDING_BILL,
  bill_id: `proof-${tag}-building`,
  memo: "per-fund refusal proof",
  fund: "building",
});
if (refused.ok) fail("building bill was NOT refused");

const paid = await send(agent, treasury, "request_payout", {
  vendor,
  amount: MISSIONS_BILL,
  bill_id: `proof-${tag}-missions`,
  memo: "per-fund success proof",
  fund: "missions",
});
const payout = await view(treasury, "get_payout", { bill_id: `proof-${tag}-missions` });
log(`get_payout(proof-${tag}-missions): ${payout ? `${payout.status} ${payout.amount} from ${payout.fund} to ${payout.vendor}` : "none"}`);
await ledger("after");
log(`vendor tUSDC balance: ${await view(token, "ft_balance_of", { account_id: vendor })}`);
log(`treasury tUSDC balance: ${await view(token, "ft_balance_of", { account_id: treasury })}`);
if (!paid.ok || payout?.status !== "paid") fail("missions bill was not paid");
log("proof complete");

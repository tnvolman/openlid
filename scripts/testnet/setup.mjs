#!/usr/bin/env node
// OpenLid testnet setup for scripts/demo.sh. NEAR TESTNET ONLY, $0 spend.
//
// - Refuses unless OPENLID_NETWORK is testnet AND the RPC reports chain_id "testnet".
// - Creates (or reuses) a root <name>.testnet account via the free testnet
//   faucet, then sub-accounts agent.*, vendor.*, treasury.*, tusdc.* under it.
//   The root account plays the church owner / treasurer for the demo.
// - Generates keys locally and writes them ONLY to $OPENLID_DEMO_KEYS_DIR
//   (default .demo-keys/, gitignored, mode 0700/0600). Key material is never
//   printed: output is account ids, file paths, and tx hashes only.
// - The agent account ends with a single function-call key limited to the
//   treasury contract's request_payout. Its bootstrap full-access key is deleted.
// - Deploys contracts/test-ft and contracts/treasury wasm if they are built.
//   If they are not present, exits with code 3 and says so. Nothing is faked.
// - Writes $KEYS_DIR/demo.env (account ids and key-file PATHS only) for the API.
//
// Exit codes: 0 ready, 1 error, 3 accounts ready but contracts not deployed.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto } from "near-api-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEYS_DIR = resolve(ROOT, process.env.OPENLID_DEMO_KEYS_DIR || ".demo-keys");
// Same default as the API (OPENLID_NEAR_RPC_URL): the official rpc.testnet.near.org is deprecated
// and answers HTTP 429. NEAR_TESTNET_RPC is still honored as a fallback name.
const RPC =
  (process.env.OPENLID_NEAR_RPC_URL || "").trim() ||
  (process.env.NEAR_TESTNET_RPC || "").trim() ||
  "https://rpc.testnet.fastnear.com";
const FAUCET = process.env.NEAR_TESTNET_FAUCET || "https://helper.nearprotocol.com/account";
const STATE_FILE = join(KEYS_DIR, "state.json");
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const PER_BILL_LIMIT = process.env.DEMO_PER_BILL_LIMIT || "100000000"; // 100 tUSDC
const MONTHLY_CAP = process.env.DEMO_MONTHLY_CAP || "10000000000"; // 10,000 tUSDC

// Never let a secret reach stdout/stderr, even inside an error message.
const redact = (s) => String(s).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, "ed25519:<redacted>");
const log = (...a) => console.log(redact(a.join(" ")));
const fail = (msg, code = 1) => {
  console.error(redact(`testnet setup: ${msg}`));
  process.exit(code);
};

// --- guards -----------------------------------------------------------------
const network = (process.env.OPENLID_NETWORK || "testnet").toLowerCase();
if (network !== "testnet") fail(`OPENLID_NETWORK=${network}. This demo runs on NEAR testnet only.`);

const provider = new JsonRpcProvider({ url: RPC });
const status = await provider.viewNodeStatus().catch((e) => fail(`cannot reach ${RPC}: ${e.message}`));
if (status.chain_id !== "testnet") fail(`RPC ${RPC} reports chain_id=${status.chain_id}, not testnet. Refusing.`);

mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
chmodSync(KEYS_DIR, 0o700);
try {
  execFileSync("git", ["-C", ROOT, "check-ignore", "-q", KEYS_DIR]);
} catch {
  fail(`${KEYS_DIR} is not gitignored. Refusing to write keys there.`);
}

// --- key files (near-cli legacy credential format, never printed) -----------
const keyPath = (accountId) => join(KEYS_DIR, `${accountId}.json`);

function newKeyFile(accountId, kp = KeyPair.fromRandom("ed25519")) {
  writeFileSync(
    keyPath(accountId),
    JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }),
    { mode: 0o600 },
  );
  return kp;
}

function loadKey(accountId) {
  const p = keyPath(accountId);
  if (!existsSync(p)) return null;
  return KeyPair.fromString(JSON.parse(readFileSync(p, "utf8")).private_key);
}

const accountFor = (id, kp) => new Account(id, provider, new KeyPairSigner(kp));
const exists = async (id) => provider.viewAccount({ accountId: id }).then(() => true, () => false);
const txLink = (r) => (r?.transaction?.hash ? `${EXPLORER}${r.transaction.hash}` : "(no tx hash)");

async function waitForAccount(id, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await exists(id)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`account ${id} did not appear on testnet after ${seconds}s`);
}


async function accountAmount(id) {
  const a = await provider.viewAccount({ accountId: id });
  return BigInt(a.amount);
}

async function createFaucetAccount() {
  const id = `openlid-fund-${Date.now().toString(36)}.testnet`;
  const kp = newKeyFile(id);
  log(`requesting extra testnet NEAR via faucet account ${id}`);
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  }).catch((e) => fail(`faucet unreachable: ${e.message}`));
  if (!res.ok) fail(`faucet refused (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  await waitForAccount(id);
  log(`created ${id} (key file ${keyPath(id)})`);
  return { id, kp };
}

async function transferNear(fromId, fromKey, toId, amountYocto) {
  const acct = accountFor(fromId, fromKey);
  const r = await acct.transfer({ receiverId: toId, amount: amountYocto.toString() });
  log(`transferred ${amountYocto} yoctoNEAR to ${toId}: ${txLink(r)}`);
  return r;
}

async function ensureOwnerHas(minYocto) {
  let have = await accountAmount(ids.owner);
  while (have < minYocto) {
    const extra = await createFaucetAccount();
    const extraBal = await accountAmount(extra.id);
    const keep = BigInt(nearToYocto("0.05"));
    const send = extraBal > keep ? extraBal - keep : 0n;
    if (send === 0n) fail(`faucet account ${extra.id} had no transferable balance`);
    await transferNear(extra.id, extra.kp, ids.owner, send);
    have = await accountAmount(ids.owner);
  }
}

async function ensureMin(id, minNear) {
  const need = BigInt(nearToYocto(String(minNear)));
  const have = await accountAmount(id);
  if (have >= need) return;
  const short = need - have + BigInt(nearToYocto("0.05"));
  await ensureOwnerHas(short + BigInt(nearToYocto("1")));
  await transferNear(ids.owner, rootKey, id, short);
}

// --- root account via faucet -------------------------------------------------
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

let rootId = process.env.DEMO_ROOT_ACCOUNT || state.root;
let rootKey = rootId ? loadKey(rootId) : null;

if (rootId && rootKey && (await exists(rootId))) {
  log(`reusing testnet account ${rootId} (key file ${keyPath(rootId)})`);
} else {
  rootId = `openlid-demo-${Date.now().toString(36)}.testnet`;
  rootKey = newKeyFile(rootId);
  log(`requesting testnet account ${rootId} from faucet ${FAUCET}`);
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: rootId, newAccountPublicKey: rootKey.getPublicKey().toString() }),
  }).catch((e) => fail(`faucet unreachable: ${e.message}`));
  if (!res.ok) fail(`faucet refused (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  await waitForAccount(rootId);
  log(`created ${rootId} (key file ${keyPath(rootId)})`);
}
state.root = rootId;
saveState();

const owner = accountFor(rootId, rootKey);
const sub = (p) => `${p}.${rootId}`;
const ids = { owner: rootId, agent: sub("agent"), vendor: sub("vendor"), treasury: sub("treasury"), token: sub("tusdc") };

// Testnet NEAR from the faucet only. Sizes leave room for contract storage.
const funding = { agent: "1", vendor: "0.2", treasury: "7", tusdc: "5.5" };

async function ensureSub(prefix) {
  const id = sub(prefix);
  if (await exists(id)) return loadKey(id);
  const kp = newKeyFile(id);
  const r = await owner.createSubAccount({
    accountOrPrefix: prefix,
    publicKey: kp.getPublicKey(),
    nearToTransfer: nearToYocto(funding[prefix]),
  });
  log(`created ${id}: ${txLink(r)}`);
  return kp;
}

const keys = {};
for (const p of Object.keys(funding)) keys[p] = await ensureSub(p);

// --- contracts ------------------------------------------------------------
// Directory is contracts/<dir>; cargo names the wasm after the package (openlid_treasury, openlid_test_ft).
const wasmCandidates = (dir, stem) => [
  join(ROOT, "contracts", dir, "target/near", `${stem}.wasm`),
  join(ROOT, "contracts", dir, "target/wasm32-unknown-unknown/release", `${stem}.wasm`),
  join(ROOT, "contracts/target/wasm32-unknown-unknown/release", `${stem}.wasm`),
  join(ROOT, "target/wasm32-unknown-unknown/release", `${stem}.wasm`),
];
const findWasm = (dir, stems) => {
  for (const stem of stems) {
    const hit = wasmCandidates(dir, stem).find((p) => existsSync(p));
    if (hit) return hit;
  }
  return undefined;
};

const treasuryWasm = findWasm("treasury", ["openlid_treasury", "treasury", "openlid-treasury"]);
const ftWasm = findWasm("test-ft", ["openlid_test_ft", "test_ft", "openlid-test-ft"]);

function writeDemoEnv(deployed) {
  // Paths and account ids only. No key material.
  const lines = [
    "# Generated by scripts/testnet/setup.mjs. Testnet only. Paths and ids, no keys.",
    "OPENLID_NETWORK=testnet",
    `OPENLID_CONTRACT_ID=${ids.treasury}`,
    `OPENLID_OWNER_ACCOUNT_ID=${ids.owner}`,
    `OPENLID_AGENT_ACCOUNT_ID=${ids.agent}`,
    `OPENLID_AGENT_KEY_FILE=${keyPath(ids.agent)}`,
    `OPENLID_OWNER_KEY_FILE=${keyPath(ids.owner)}`,
    `OPENLID_USDC_TOKEN_ID=${ids.token}`,
    `OPENLID_DEMO_KEYS_DIR=${KEYS_DIR}`,
    "ONECLICK_API_KEY=",
    "ONECLICK_DRY_RUN=true",
    `DEMO_VENDOR=${ids.vendor}`,
    `DEMO_CONTRACTS_DEPLOYED=${deployed ? "1" : "0"}`,
  ];
  writeFileSync(join(KEYS_DIR, "demo.env"), lines.join("\n") + "\n", { mode: 0o600 });
  log(`wrote ${join(KEYS_DIR, "demo.env")} (account ids and key-file paths only)`);
}

if (!treasuryWasm || !ftWasm) {
  writeDemoEnv(false);
  fail(
    [
      "testnet accounts are ready, but contract wasm was not found, so nothing was deployed:",
      `  treasury: ${treasuryWasm ?? "missing (contracts/treasury not built or not in this tree)"}`,
      `  test-ft:  ${ftWasm ?? "missing (contracts/test-ft not built or not in this tree)"}`,
      "Build them (cargo near build, or cargo build --target wasm32-unknown-unknown --release) and re-run.",
    ].join("\n"),
    3,
  );
}

const call = async (acct, contractId, methodName, args, deposit = "0") =>
  acct.callFunction({ contractId, methodName, args, deposit: BigInt(deposit), gas: 100_000_000_000_000n });

const tokenAcct = accountFor(ids.token, keys.tusdc);
const treasuryAcct = accountFor(ids.treasury, keys.treasury);

// Existing accounts may have been created with the older, lower funding amounts.
await ensureMin(ids.token, funding.tusdc);
await ensureMin(ids.treasury, funding.treasury);

if (!state.ftDeployed) {
  const r = await tokenAcct.deployContract(readFileSync(ftWasm));
  log(`deployed test FT to ${ids.token}: ${txLink(r)}`);
  // Init args are not fixed by INTERFACES.md; override with DEMO_FT_INIT_ARGS (JSON) if they differ.
  const ftInit = process.env.DEMO_FT_INIT_ARGS
    ? JSON.parse(process.env.DEMO_FT_INIT_ARGS)
    : { owner: ids.owner }; // test-ft::new(owner)
  await call(tokenAcct, ids.token, process.env.DEMO_FT_INIT_METHOD || "new", ftInit);
  log(`initialized test FT (tUSDC) owner=${ids.owner}`);
  state.ftDeployed = true;
  saveState();
}

if (!state.treasuryDeployed) {
  const r = await treasuryAcct.deployContract(readFileSync(treasuryWasm));
  log(`deployed treasury to ${ids.treasury}: ${txLink(r)}`);
  await call(treasuryAcct, ids.treasury, "new", {
    owner: ids.owner,
    agent: ids.agent,
    usdc_token: ids.token,
    per_bill_limit: PER_BILL_LIMIT,
    monthly_cap: MONTHLY_CAP,
    // Deploy-time allowlist: active immediately. Later changes still wait 24h.
    initial_allowlist: [ids.vendor],
  });
  log(`initialized treasury: per_bill_limit=${PER_BILL_LIMIT} monthly_cap=${MONTHLY_CAP} initial_vendor=${ids.vendor}`);
  state.treasuryDeployed = true;
  saveState();
}

// NEP-145 storage registration so the treasury and vendor can hold tUSDC.
// Tolerated if the test FT does not implement storage_deposit.
for (const acct of [ids.treasury, ids.vendor]) {
  try {
    await call(owner, ids.token, "storage_deposit", { account_id: acct }, nearToYocto("0.00125"));
  } catch (e) {
    log(`note: storage_deposit for ${acct} not applied (${redact(e.message).slice(0, 120)})`);
  }
}

// Agent: one function-call key for request_payout on the treasury, nothing else.
if (!state.agentRestricted) {
  const agentFull = keys.agent;
  const agentAcct = accountFor(ids.agent, agentFull);
  // Add the restricted key on-chain, then swap the key file, then drop the full key.
  const fullPath = keyPath(ids.agent);
  const fc = KeyPair.fromRandom("ed25519");
  await agentAcct.addFunctionCallAccessKey({
    publicKey: fc.getPublicKey(),
    contractId: ids.treasury,
    methodNames: ["request_payout"],
    allowance: nearToYocto("0.5"),
  });
  newKeyFile(ids.agent, fc);
  await agentAcct.deleteKey(agentFull.getPublicKey());
  log(`agent ${ids.agent} now has only a function-call key for request_payout (key file ${fullPath})`);
  state.agentRestricted = true;
  saveState();
}

// Allowlist: propose now; the contract only lets it execute 24h later.
const allowlist = await provider.callFunction({ contractId: ids.treasury, method: "get_allowlist", args: {} }).catch(() => null);
if (Array.isArray(allowlist) && allowlist.includes(ids.vendor)) {
  log(`vendor ${ids.vendor} is allowlisted`);
} else {
  const proposal = await provider
    .callFunction({ contractId: ids.treasury, method: "get_proposal", args: { vendor: ids.vendor } })
    .catch(() => null);
  if (!proposal) {
    await call(owner, ids.treasury, "propose_allowlist_change", { vendor: ids.vendor, action: "add" });
    log(`proposed allowlist add for ${ids.vendor}; executable after the contract's 24h timelock`);
  } else {
    try {
      await call(owner, ids.treasury, "execute_allowlist_change", { vendor: ids.vendor });
      log(`executed allowlist add for ${ids.vendor}`);
    } catch (e) {
      log(`allowlist add for ${ids.vendor} is still inside the 24h timelock (execute_after=${proposal.execute_after})`);
    }
  }
}

writeDemoEnv(true);
log("testnet setup complete");

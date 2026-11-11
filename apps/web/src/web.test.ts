import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApi } from "./api.ts";
import { DEFAULT_API_BASE, isMockMode, resolveApiBase } from "./config.ts";
import { CSV_FILENAME, triggerCsvDownload } from "./csv.ts";
import { createMockFetch, fixtureState, summarize } from "./fixtures.ts";
import { formatTime, formatUsdc, friendlyError, groupGiftsByFund } from "./format.ts";
import { formatUpdated, load } from "./load.ts";
import { renderGifts, renderHolds, renderPayouts, renderReconciliation, renderSummary } from "./render.ts";
import {
  AMOUNT_CAPTION,
  BOOK_VALUE_LABEL,
  BOUNDARY_LINES,
  FUND_RESTRICTION,
  FUND_SILO_NOTE,
  RECEIPT_NOTE,
  RECON_NOTE,
  TESTNET_NOTICE,
} from "./types.ts";

describe("formatUsdc", () => {
  it("formats 6-decimal atomic strings", () => {
    assert.equal(formatUsdc("100000000"), "100.00 USDC");
    assert.equal(formatUsdc("4200000000"), "4,200.00 USDC");
    assert.equal(formatUsdc("1"), "0.00 USDC");
    assert.equal(formatUsdc("1234567"), "1.23 USDC");
    assert.equal(formatUsdc("not-a-number"), "—");
  });
});

describe("gift grouping", () => {
  const { gifts } = fixtureState();

  it("groups by fund and keeps refunded and failed gifts", () => {
    const g = groupGiftsByFund(gifts);
    assert.deepEqual(g.general.map((x) => x.id), ["g4", "g1"]);
    assert.deepEqual(g.missions.map((x) => x.id), ["g5", "g2"]);
    assert.deepEqual(g.building.map((x) => x.id), ["g6", "g3"]);
    assert.equal(g.missions.find((x) => x.id === "g5")?.status, "refunded");
    assert.equal(g.building.find((x) => x.id === "g6")?.status, "failed");
    assert.equal(g.other.length, 0);
  });

  it("always renders all three funds, even when empty", () => {
    const html = renderGifts([]);
    for (const f of ["general", "missions", "building"]) assert.match(html, new RegExp(`data-fund="${f}"`));
  });

  it("renders refunded and failed statuses", () => {
    const html = renderGifts(gifts);
    assert.match(html, /status-refunded">refunded</);
    assert.match(html, /status-failed">failed</);
    assert.match(html, /1 failed, 1 settled/);
  });

  it("fixture gifts are dry-run quotes with simulated addresses, not live deposits", () => {
    for (const g of gifts) {
      assert.equal(g.quoteMode, "dry_run");
      assert.match(g.depositAddress, /^sim:/);
    }
    assert.equal(new Set(gifts.map((g) => g.depositAddress)).size, gifts.length);
  });

  it("marks simulated deposit addresses", () => {
    assert.match(renderGifts(gifts), /<code title="sim:g1">sim:g1<\/code> <span class="badge">simulated<\/span>/);
  });

  it("escapes donor names", () => {
    const html = renderGifts([{ ...gifts[0], donor: "<script>x</script>" }]);
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe("holds", () => {
  it("renders approve and reject buttons for held bills only", () => {
    const html = renderHolds([
      { bill_id: "b1", vendor: "v.testnet", amount: "1", memo: "", fund: "missions", status: "held" },
      { bill_id: "b2", vendor: "v.testnet", amount: "1", memo: "", fund: "general", status: "approved" },
    ]);
    assert.match(html, /data-action="approve" data-bill-id="b1"/);
    assert.match(html, /data-action="reject" data-bill-id="b1"/);
    assert.ok(!html.includes('data-bill-id="b2"'));
  });

  it("approve posts to /api/holds/:billId/approve and creates a payout", async () => {
    const f = createMockFetch();
    const api = createApi("", f);
    await api.approveHold("bill-roof-002");
    assert.equal((await api.heldHolds()).length, 0);
    assert.ok((await api.payouts()).some((p) => p.bill_id === "bill-roof-002" && p.status === "paid"));
  });

  it("reject posts to /api/holds/:billId/reject without paying", async () => {
    const f = createMockFetch();
    const api = createApi("", f);
    await api.rejectHold("bill-roof-002");
    assert.equal(f.state.holds[0].status, "rejected");
    assert.equal((await api.payouts()).length, 1);
  });

  it("surfaces the API { error } body on 4xx", async () => {
    const api = createApi("", createMockFetch());
    await api.rejectHold("bill-roof-002");
    await assert.rejects(api.approveHold("bill-roof-002"), /is rejected/);
  });
});

describe("API client targets INTERFACES.md routes", () => {
  it("calls the documented URLs and methods", async () => {
    const seen: string[] = [];
    const rec = async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      const body = url.includes("/holds/") ? {} : { gifts: [], payouts: [], holds: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const api = createApi("http://127.0.0.1:8787/", rec);
    await api.gifts();
    await api.payouts();
    await api.heldHolds();
    await api.approveHold("bill/1");
    await api.rejectHold("bill-2");
    assert.deepEqual(seen, [
      "GET http://127.0.0.1:8787/api/gifts",
      "GET http://127.0.0.1:8787/api/payouts",
      "GET http://127.0.0.1:8787/api/holds?status=held",
      "POST http://127.0.0.1:8787/api/holds/bill%2F1/approve",
      "POST http://127.0.0.1:8787/api/holds/bill-2/reject",
    ]);
    assert.equal(api.exportCsvUrl, "http://127.0.0.1:8787/api/export.csv");
  });

  it("summary from the fixture matches the contract shape", async () => {
    const s = await createApi("", createMockFetch()).summary();
    assert.equal(s.receiptNote, RECEIPT_NOTE);
    assert.deepEqual(s.giftsByFund.general, {
      restriction: "without donor restrictions",
      count: 1,
      received: "100000000",
      paidOut: "0",
      held: "90000000",
      available: "10000000",
    });
    assert.equal(s.reconciliation?.status, "match");
    assert.equal(s.holds.heldCount, 1);
    assert.match(renderSummary(s), /90\.00 USDC/);
  });
});

describe("per-fund accounting", () => {
  const cells = (html: string, fund: string) =>
    [...html.match(new RegExp(`<tr data-fund="${fund}">([\\s\\S]*?)</tr>`))![1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);

  it("summary table: Fund / Restriction / Gifts / Received / Paid out / Held / Available, plus the live balance line", async () => {
    const s = await createApi("", createMockFetch()).summary();
    const html = renderSummary(s);
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, ["Fund", "Restriction", "Gifts", "Received", "Paid out", "Held", "Available"]);
    assert.ok(!html.includes(">Settled<"));
    assert.match(html, /<p class="kpi-label">Treasury balance<\/p><p class="kpi-num">230\.00 <span class="unit">USDC<\/span><\/p><p class="kpi-note">Live, NEAR testnet<\/p>/);
    // Only settled gifts count; building paid the 180 electric bill out of its 250; general's 90 hold is reserved.
    assert.deepEqual(cells(html, "general"), ["general", "without donor restrictions", "1", "100.00 USDC", "0.00 USDC", "90.00 USDC", "10.00 USDC"]);
    assert.deepEqual(cells(html, "missions"), ["missions", "with donor restrictions", "1", "60.00 USDC", "0.00 USDC", "0.00 USDC", "60.00 USDC"]);
    assert.deepEqual(cells(html, "building"), ["building", "with donor restrictions", "1", "250.00 USDC", "180.00 USDC", "0.00 USDC", "70.00 USDC"]);
  });

  it("restriction labels use GAAP wording and never imply general can pay any bill (A6/A7)", async () => {
    assert.deepEqual(FUND_RESTRICTION, {
      general: "without donor restrictions",
      missions: "with donor restrictions",
      building: "with donor restrictions",
    });
    const html = renderSummary(await createApi("", createMockFetch()).summary());
    assert.ok(html.includes(FUND_SILO_NOTE));
    assert.match(FUND_SILO_NOTE, /still cannot pay a missions or building bill/);
    assert.match(FUND_SILO_NOTE, /interfund transfer/);
    // No looser wording: no bare "restricted"/"unrestricted" and no "any bill".
    const text = html.replace(/with(out)? donor restrictions/g, "");
    assert.ok(!/\bunrestricted\b|\brestricted\b|any bill/i.test(text), text);
  });

  it("fixture bills each fit their fund; available = received - paid out - held", () => {
    const st = fixtureState();
    const s = summarize(st);
    for (const f of ["general", "missions", "building"] as const) {
      const row = s.giftsByFund[f];
      assert.equal(BigInt(row.available), BigInt(row.received) - BigInt(row.paidOut) - BigInt(row.held));
      assert.ok(BigInt(row.available) >= 0n, f);
    }
    assert.equal(st.payouts[0].fund, "building");
  });

  it("payouts and holds tables show fund, dates, and payment / request references (C4)", () => {
    const { payouts, holds } = fixtureState();
    const p = renderPayouts(payouts);
    assert.match(p, /<th>Bill<\/th><th>Fund<\/th><th>Vendor<\/th><th class="num">Amount<\/th><th>Memo<\/th><th>Requested<\/th><th>Paid<\/th><th>Payment ref<\/th>/);
    assert.match(p, /<td class="bill"><span class="bill-name" title="Electric, October">Electric, October<\/span>.*?<code title="bill-electric-001">bill-electric-001<\/code>(?:(?!<\/td>).)*<\/td><td>building<\/td>/);
    assert.match(p, /<td title="2026-11-03T15:20:00\.000Z">3 Nov 15:20 UTC<\/td><td title="2026-11-03T15:20:00\.000Z">3 Nov 15:20 UTC<\/td>/);
    assert.equal(formatTime("2026-11-03T15:20:00.000Z"), "3 Nov 15:20 UTC");
    assert.equal(formatTime("2026-11-10T18:05:00.000Z"), "10 Nov 18:05 UTC");
    assert.match(p, /<code title="demoTxElectric001PaidOnTestnet">/);
    const h = renderHolds(holds);
    assert.match(h, /<th>Bill<\/th><th>Fund<\/th><th>Vendor<\/th><th class="num">Amount<\/th><th>Memo<\/th><th>Requested<\/th><th>Request ref<\/th>/);
    assert.match(h, /<td class="bill"><span class="bill-name" title="Roof repair deposit">Roof repair deposit<\/span>.*?<code title="bill-roof-002">bill-roof-002<\/code>(?:(?!<\/td>).)*<\/td><td>general<\/td>/);
    assert.match(h, /<td title="2026-11-10T18:05:00\.000Z">10 Nov 18:05 UTC<\/td>/);
    assert.match(h, /<code title="demoTxRoof002RequestOnTestnet">/);
    assert.equal(formatTime(null), "—");
    assert.match(renderPayouts([{ ...payouts[0], paidAt: null, paymentTxHash: null }]), /<td>—<\/td><td>—<\/td>/);
  });

  it("approving a hold records its paid time and payment reference", async () => {
    const f = createMockFetch();
    const api = createApi("", f);
    await api.approveHold("bill-roof-002");
    const paid = (await api.payouts()).find((p) => p.bill_id === "bill-roof-002")!;
    assert.equal(paid.fund, "general");
    assert.ok(paid.paidAt);
    assert.equal(paid.paymentTxHash, "demoTxApprove-bill-roof-002");
    const s = await api.summary();
    assert.deepEqual([s.giftsByFund.general.paidOut, s.giftsByFund.general.held, s.giftsByFund.general.available], ["90000000", "0", "10000000"]);
  });

  it("approve blocked by the fund surfaces a clear error and leaves the hold held", async () => {
    const f = createMockFetch();
    f.state.holds[0] = { ...f.state.holds[0], fund: "building", amount: "200000000" };
    const api = createApi("", f);
    await assert.rejects(api.approveHold("bill-roof-002"), (err: Error) => {
      assert.match(err.message, /insufficient fund balance: building has 70000000 available, bill needs 200000000/);
      assert.equal(
        friendlyError(err.message),
        "Not enough in the building fund: 70.00 USDC available, this bill needs 200.00 USDC. Other funds cannot pay it.",
      );
      return true;
    });
    assert.equal(f.state.holds[0].status, "held");
    assert.equal((await api.payouts()).length, 1);
    assert.equal(friendlyError("contract rejected: monthly cap exceeded"), "contract rejected: monthly cap exceeded");
  });
});

describe("cash vs fund ledgers (B3)", () => {
  it("match: shows cash next to the ledger total with a match flag", () => {
    const html = renderSummary(summarize(fixtureState()));
    assert.match(html, /<p class="kpi-label">Treasury balance<\/p><p class="kpi-num">230\.00 <span class="unit">USDC<\/span><\/p><p class="kpi-note">Live, NEAR testnet<\/p>/);
    assert.match(html, /<p class="kpi-label">Fund ledgers<\/p><p class="kpi-num">230\.00 <span class="unit">USDC<\/span><\/p><p class="recon recon-match" data-recon="match">Cash matches the fund ledgers\.<\/p><p class="kpi-note">Received − paid, NEAR testnet<\/p>/);
    assert.ok(!/on-chain/i.test(html), "no 'on-chain' in visible labels");
    assert.match(html, /data-recon="match"/);
    assert.ok(!html.includes("Mismatch"));
  });

  it("mismatch: a visible alert with the difference", () => {
    const html = renderSummary(summarize(fixtureState(), "239950000"));
    assert.match(html, /data-recon="mismatch" role="alert"><strong>Mismatch:<\/strong> treasury cash differs from the fund ledgers by 9\.95 USDC/);
    const short = renderSummary(summarize(fixtureState(), "200000000"));
    assert.match(short, /differs from the fund ledgers by -30\.00 USDC/);
  });

  it("the reconciliation line and its amount-check note are always visible: match, mismatch, unknown, or missing", () => {
    const base = summarize(fixtureState());
    const cases = [
      ["match", base],
      ["mismatch", summarize(fixtureState(), "1")],
      ["unknown", { ...base, treasuryBalance: null, reconciliation: { ...base.reconciliation!, cash: null, difference: null, status: "unknown" as const } }],
      ["unknown", { ...base, reconciliation: undefined }],
    ] as const;
    for (const [status, s] of cases) {
      const html = renderSummary(s);
      assert.match(html, new RegExp(`data-recon="${status}"`), status);
      assert.ok(html.includes(RECON_NOTE), status);
    }
    assert.match(renderSummary(base), /<p class="recon recon-match" data-recon="match">Cash matches the fund ledgers\.<\/p>/);
    assert.match(RECON_NOTE, /not checked against the tokens received on NEAR testnet/);
  });

  it("unknown cash is said plainly, not hidden", () => {
    const s = summarize(fixtureState());
    const html = renderReconciliation({
      ...s,
      treasuryBalance: null,
      reconciliation: { ...s.reconciliation!, cash: null, difference: null, status: "unknown" },
    });
    assert.ok(!html.includes("Treasury balance"));
    assert.match(html, /data-recon="unknown">Cash could not be read/);
  });
});

describe("boundary lines (C3 / D2 / D3 / D4)", () => {
  it("the page shows all boundary lines, verbatim, plus the receipt and testnet notices", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.equal(BOUNDARY_LINES.length, 6);
    for (const line of BOUNDARY_LINES) assert.ok(html.includes(`<li>${line}</li>`), line);
    assert.match(BOUNDARY_LINES[0], /IRS Publication 1771/);
    assert.match(BOUNDARY_LINES[1], /not GAAP financial statements and not an audit, review, or compilation/);
    assert.match(BOUNDARY_LINES[2], /unauthenticated and the server signs as owner/);
    assert.match(BOUNDARY_LINES[3], /does not cover interfund transfers, budgets, pledges, or tax receipts/);
    assert.ok(html.includes(">demo, not a tax document<"));
    assert.ok(html.includes(TESTNET_NOTICE));
  });

  it("the CSV header carries D2, D3, D9 and D10 after the receipt note, and fund on every row plus reconciliation", async () => {
    const text = await (await createMockFetch()("/api/export.csv")).text();
    const lines = text.trim().split("\n");
    assert.deepEqual(lines.slice(0, 5), [
      `# ${RECEIPT_NOTE}`,
      `# ${BOUNDARY_LINES[0]}`,
      `# ${BOUNDARY_LINES[1]}`,
      `# ${BOUNDARY_LINES[4]}`,
      `# ${BOUNDARY_LINES[5]}`,
    ]);
    const header = lines[5].split(",");
    const rows = lines.filter((l) => l.startsWith("gift,") || l.startsWith("payout,"));
    for (const r of rows) assert.ok(["general", "missions", "building"].includes(r.split(",")[header.indexOf("fund")]), r);
    assert.ok(lines.includes("payout,bill-electric-001,power-co.demo.testnet,building,with donor restrictions,180000000,paid,2026-11-03T15:20:00.000Z,demoTxElectric001PaidOnTestnet"));
    assert.ok(lines.includes("general,without donor restrictions,1,100000000,0,90000000,10000000"));
    assert.match(text, /fund ledgers total \(received - paid, from chain\): 230000000; match/);
  });
});

describe("noncash property and book value at receipt (D9)", () => {
  const page = () => readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("the page says gifts are noncash property, amounts are book value at receipt, not a deductible value", () => {
    const line = BOUNDARY_LINES[4];
    assert.ok(page().includes(`<li>${line}</li>`));
    assert.match(line, /noncash property, not cash/);
    assert.match(line, /book value at receipt \(church books only, as of the date and time received\), not a deductible value/);
    assert.match(line, /not a noncash acknowledgment and does not state fair market value/);
    assert.match(line, /Forms 8283 and 8282/);
    assert.match(line, /A CPA must confirm current rules/);
  });

  it("every amount table on the page is captioned book value at receipt", async () => {
    const st = fixtureState();
    const s = await createApi("", createMockFetch()).summary();
    for (const html of [renderSummary(s), renderPayouts(st.payouts), renderHolds(st.holds), renderGifts(st.gifts)]) {
      const tables = html.match(/<table>/g)?.length ?? 0;
      const captions = html.split(`<caption>${AMOUNT_CAPTION}</caption>`).length - 1;
      assert.ok(tables > 0);
      assert.equal(captions, tables, html.slice(0, 120));
    }
    assert.match(AMOUNT_CAPTION, new RegExp(`${BOOK_VALUE_LABEL}.*not a deductible value`));
  });

  it("the CSV labels amounts book value at receipt", async () => {
    const text = await (await createMockFetch()("/api/export.csv")).text();
    assert.ok(text.split("\n")[5].includes("amount_usdc_book_value_at_receipt"));
    assert.match(text, /# per-fund reconciliation \(USDC atomic units, book value at receipt;/);
  });

  it("never calls an amount a tax deduction or tax-deductible, on the page or in the CSV", async () => {
    const st = fixtureState();
    const s = await createApi("", createMockFetch()).summary();
    const rendered = [page(), renderSummary(s), renderPayouts(st.payouts), renderHolds(st.holds), renderGifts(st.gifts)].join(" ");
    const csv = await (await createMockFetch()("/api/export.csv")).text();
    for (const text of [rendered, csv]) {
      assert.ok(!/tax[- ]deductible|tax deduction|deductible amount/i.test(text));
      // "deductible" only ever appears negated.
      for (const m of text.matchAll(/.{0,6}deductible value/g)) assert.match(m[0], /not a deductible value/);
    }
  });
});

describe("no custody; legal review before real money (D10)", () => {
  it("the page says OpenLid never holds donor funds, the treasury is church-controlled, and legal review comes first", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/\s+/g, " ");
    const line = BOUNDARY_LINES[5];
    assert.ok(html.includes(`<li>${line}</li>`));
    assert.match(line, /OpenLid never holds or moves donor funds for someone else/);
    assert.match(line, /gifts go to a treasury the church controls/);
    assert.match(line, /A legal review is required before any real money/);
    assert.match(line, /testnet only; no real funds/);
  });
});

describe("CSV download", () => {
  it("clicks an anchor pointing at /api/export.csv", () => {
    const clicks: string[] = [];
    let removed = false;
    const doc = {
      body: { appendChild: () => undefined },
      createElement: () => ({
        href: "",
        download: "",
        rel: "",
        click() {
          clicks.push(`${this.href}|${this.download}`);
        },
        remove() {
          removed = true;
        },
      }),
    };
    const api = createApi(DEFAULT_API_BASE);
    triggerCsvDownload(doc, api.exportCsvUrl);
    assert.deepEqual(clicks, [`http://127.0.0.1:8787/api/export.csv|${CSV_FILENAME}`]);
    assert.ok(removed);
  });

  it("mock export carries the receipt note", async () => {
    const f = createMockFetch();
    const text = await (await f("/api/export.csv")).text();
    assert.ok(text.startsWith(`# ${RECEIPT_NOTE}`));
    assert.match(text, /gift,g5,donor-demo-5,missions,with donor restrictions,40000000,refunded/);
  });
});

describe("config and page shell", () => {
  it("defaults to 127.0.0.1:8787 and honours overrides", () => {
    assert.equal(resolveApiBase("", undefined), "http://127.0.0.1:8787");
    assert.equal(resolveApiBase("?api=http://localhost:9999/", undefined), "http://localhost:9999");
    assert.equal(resolveApiBase("", "same-origin"), "");
    assert.equal(isMockMode("?mock=1"), true);
    assert.equal(isMockMode(""), false);
  });

  it("index.html shows the exact receipt label", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.ok(html.includes(">demo, not a tax document<"));
    assert.ok(html.includes('id="download-csv"'));
    assert.ok(html.replace(/\s+/g, " ").includes(TESTNET_NOTICE), "testnet / dry-run notice on page");
  });
});

describe("premium restyle guards", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("fund table hides Received and Paid out on phones, never Held or Available", async () => {
    const html = renderSummary(await createApi("", createMockFetch()).summary());
    assert.match(html, /<th class="num hide-m">Received<\/th><th class="num hide-m">Paid out<\/th><th class="num">Held<\/th><th class="num">Available<\/th>/);
    assert.match(html, /<td class="num hide-m">100\.00 USDC<\/td><td class="num hide-m">0\.00 USDC<\/td>\s*<td class="num">90\.00 USDC<\/td><td class="num">10\.00 USDC<\/td>/);
    assert.match(read("./style.css"), /@media \(max-width: 700px\)[\s\S]*\.hide-m \{ display: none; \}/);
  });

  it("holds put Reject before Approve, with fund and amount in full on a phone facts line", () => {
    const h = renderHolds(fixtureState().holds);
    assert.ok(h.indexOf('data-action="reject"') < h.indexOf('data-action="approve"'));
    assert.match(h, /<span class="bill-facts m-only"><span class="cap">general<\/span> · 90\.00 USDC<\/span>/);
    assert.match(read("./style.css"), /@media \(max-width: 700px\)[\s\S]*\.holds \.acts \{[\s\S]*flex-direction: row;/);
    assert.match(read("./style.css"), /@media \(max-width: 700px\)[\s\S]*min-height: 44px;/);
  });

  it("copper is reserved for Approve, Reject, and the Refresh loading cue", () => {
    const css = read("./style.css");
    assert.ok(!/#9E4E2A/i.test(css));
    const blocks = css.split("}");
    let hits = 0;
    for (const b of blocks) {
      if (!b.includes("var(--copper")) continue;
      hits += 1;
      const sel = b.split("{")[0].replace(/\/\*[\s\S]*?\*\//g, "").trim();
      assert.match(sel, /btn-approve|btn-reject|#refresh|#updated|@keyframes|prefers-reduced-motion/, sel);
    }
    assert.ok(hits > 0);
  });

  it("no visible 'on-chain' wording on the page or in rendered sections", async () => {
    const st = fixtureState();
    const s = await createApi("", createMockFetch()).summary();
    const text = [read("../index.html"), renderSummary(s), renderPayouts(st.payouts), renderHolds(st.holds), renderGifts(st.gifts)].join(" ");
    assert.ok(!/on-chain/i.test(text));
  });

  it("legal notices sit in a labelled disclosure and fonts ship with their OFL licenses", () => {
    const html = read("../index.html").replace(/\s+/g, " ");
    assert.match(html, /<details class="legal"> <summary>Full legal notices: what this demo is not \(6\)<\/summary> <ul class="boundaries" id="boundaries"/);
    assert.ok(html.includes('<div class="wordmark">OpenLid</div>'));
    for (const f of ["SourceSerif4opsz-wght.ttf", "Geistwght.ttf", "GeistMonowght.ttf", "source-serif-4-LICENSE.md", "geist-LICENSE.txt"]) {
      const body = readFileSync(new URL(`../public/fonts/${f}`, import.meta.url));
      assert.ok(body.length > 0, f);
      if (!f.endsWith(".ttf")) assert.match(body.toString(), /SIL Open Font License, Version 1\.1/, f);
    }
    assert.ok(!/fonts\.googleapis|fonts\.gstatic|cdn/i.test(read("./theme.css") + html));
  });
});

describe("Refresh loading state", () => {
  it("clicking #refresh calls the four endpoints and changes #updated", async () => {
    const calls: string[] = [];
    const inner = createMockFetch();
    const fetchImpl = async (input: string, init?: RequestInit) => {
      calls.push(input);
      return inner(input, init);
    };
    const api = createApi("", fetchImpl);
    const flash = { tokens: new Set<string>() };
    const els = {
      refreshBtn: {
        disabled: false,
        textContent: "Refresh" as string | null,
        attrs: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          this.attrs[name] = value;
        },
        removeAttribute(name: string) {
          delete this.attrs[name];
        },
      },
      error: { hidden: true, textContent: "" },
      summary: { innerHTML: "" },
      holds: { innerHTML: "" },
      payouts: { innerHTML: "" },
      gifts: { innerHTML: "" },
      updated: {
        textContent: "",
        offsetWidth: 1,
        classList: {
          remove: (c: string) => flash.tokens.delete(c),
          add: (c: string) => flash.tokens.add(c),
        },
      },
    };
    const renderers = { renderSummary, renderHolds, renderPayouts, renderGifts };

    await load(api, els, renderers, new Date("2026-11-11T20:04:35.000Z"));
    const first = els.updated.textContent;
    assert.match(first, /updated /);
    assert.match(first, /\d{1,2}:\d{2}:\d{2}/);
    assert.deepEqual(
      calls.filter((u) => u.startsWith("/api/")).sort(),
      ["/api/gifts", "/api/holds?status=held", "/api/payouts", "/api/summary"].sort(),
    );
    assert.equal(els.refreshBtn.textContent, "Refresh");
    assert.equal(els.refreshBtn.disabled, false);
    assert.ok(!("aria-busy" in els.refreshBtn.attrs));
    assert.ok(els.summary.innerHTML.length > 0);
    assert.ok(flash.tokens.has("updated-flash"));

    // A second click must hit the four endpoints again and change #updated.
    calls.length = 0;
    els.updated.textContent = first;
    await load(api, els, renderers, new Date("2026-11-11T20:04:41.000Z"));
    assert.notEqual(els.updated.textContent, first);
    assert.match(els.updated.textContent, /updated /);
    assert.match(els.updated.textContent, /\d{1,2}:\d{2}:\d{2}/);
    assert.deepEqual(
      calls.filter((u) => u.startsWith("/api/")).sort(),
      ["/api/gifts", "/api/holds?status=held", "/api/payouts", "/api/summary"].sort(),
    );
    assert.match(formatUpdated(new Date("2026-11-11T20:04:41.000Z")), /updated /);
    assert.match(formatUpdated(new Date("2026-11-11T20:04:41.000Z")), /\d{1,2}:\d{2}:\d{2}/);
  });
});

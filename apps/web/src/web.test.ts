import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApi } from "./api.ts";
import { DEFAULT_API_BASE, isMockMode, resolveApiBase } from "./config.ts";
import { CSV_FILENAME, triggerCsvDownload } from "./csv.ts";
import { createMockFetch, fixtureState } from "./fixtures.ts";
import { formatUsdc, groupGiftsByFund } from "./format.ts";
import { renderGifts, renderHolds, renderSummary } from "./render.ts";
import { RECEIPT_NOTE, TESTNET_NOTICE } from "./types.ts";

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
      { bill_id: "b1", vendor: "v.testnet", amount: "1", memo: "", status: "held" },
      { bill_id: "b2", vendor: "v.testnet", amount: "1", memo: "", status: "approved" },
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
    assert.equal(s.giftsByFund.general.settledAmount, "100000000");
    assert.equal(s.holds.heldCount, 1);
    assert.match(renderSummary(s), /4,200\.00 USDC/);
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
    assert.match(text, /gift,g5,donor-demo-5,missions,40000000,refunded/);
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

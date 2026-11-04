import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { fakeRiot, fakeDb, DAILY, GOOD_SSID, ROTATED_SSID } from "./fixtures.js";

const TOKEN = "aaa.bbb.ccc";
const original = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  globalThis.fetch = fakeRiot({ realFetch: null, calls });
});
afterEach(() => { globalThis.fetch = original; });

const post = (body, env = {}) =>
  worker.fetch(new Request("https://shop.test/api/store", { method: "POST", body: JSON.stringify(body) }), env);

test("fetches and normalizes the store, auto-detecting the shard", async () => {
  const res = await post({ accessToken: TOKEN, idToken: "x.y.z", region: "auto" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const data = await res.json();

  assert.equal(data.shard, "eu");
  assert.equal(data.gameName, "Tester");
  assert.deepEqual(data.daily.offers.map((o) => [o.itemId, o.cost.amount]), DAILY);
  assert.equal(data.daily.remaining, 40000);
  assert.equal(data.accessories.offers.length, 4);
  assert.equal(data.accessories.offers[0].cost.currency, "85ca954a-41f2-ce94-9b45-8ca3dd39a00d");
  assert.equal(data.nightMarket.offers[0].discountPercent, 34);
  assert.equal(data.nightMarket.offers[0].discounted.amount, 578);
  assert.deepEqual(data.bundles.map((b) => b.cost.amount), [3775, 7100]);

  const store = calls.find((c) => c.url.includes(".a.pvp.net"));
  assert.equal(store.url, "https://pd.eu.a.pvp.net/store/v3/storefront/puuid-123");
  assert.equal(store.method, "POST");
  assert.equal(store.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(store.headers["X-Riot-Entitlements-JWT"], "ent.tok.en");
  assert.equal(store.headers["X-Riot-ClientVersion"], "release-test");
  assert.ok(store.headers["X-Riot-ClientPlatform"]);
});

test("a chosen region skips geo detection and maps latam/br to the na shard", async () => {
  const res = await post({ accessToken: TOKEN, region: "br" });
  assert.equal((await res.json()).shard, "na");
  assert.ok(!calls.some((c) => c.url.includes("riot-geo")));
});

test("auto region without an id_token asks the user to pick one", async () => {
  const res = await post({ accessToken: TOKEN, region: "auto" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Pick your region/);
});

test("expired login comes back as 401 with a re-login message", async () => {
  globalThis.fetch = fakeRiot({ realFetch: null, calls, storeStatus: 401 });
  const res = await post({ accessToken: TOKEN, region: "na" });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /log in again/);
});

test("rejects missing or malformed tokens and bad regions before calling Riot", async () => {
  for (const body of [{}, { accessToken: "not-a-jwt" }, { accessToken: TOKEN, region: "mars" }, { accessToken: TOKEN, idToken: 5 }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test("only POST is accepted and unknown /api paths 404", async () => {
  const get = await worker.fetch(new Request("https://shop.test/api/store"), {});
  assert.equal(get.status, 405);
  const other = await worker.fetch(new Request("https://shop.test/api/nope"), {});
  assert.equal(other.status, 404);
});

test("a saved ssid cookie is traded for fresh tokens and the rotated cookie is returned", async () => {
  const res = await post({ ssid: GOOD_SSID, region: "auto" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ssid, ROTATED_SSID);
  assert.equal(data.shard, "eu");
  assert.equal(data.daily.offers.length, 4);

  const reauth = calls.find((c) => c.url.includes("/authorize"));
  assert.match(reauth.url, /prompt=none/);
  assert.equal(reauth.headers.Cookie, `ssid=${GOOD_SSID}`);
  const store = calls.find((c) => c.url.includes(".a.pvp.net"));
  assert.equal(store.headers.Authorization, "Bearer fresh.access.token");
  // The fresh tokens stay inside the Worker.
  assert.equal(data.accessToken, undefined);
});

test("a signed-out ssid comes back as login_expired so the page can forget it", async () => {
  const res = await post({ ssid: "signed-out-cookie-value.zzz", region: "na" });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.code, "login_expired");
  assert.ok(!calls.some((c) => c.url.includes(".a.pvp.net")));
});

test("other failures with a saved ssid carry no login_expired code", async () => {
  globalThis.fetch = fakeRiot({ realFetch: null, calls, storeStatus: 503 });
  const res = await post({ ssid: GOOD_SSID, region: "na" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, undefined);
});

test("rejects malformed ssid values before calling Riot", async () => {
  for (const ssid of ["", "has spaces", "semi;colon", 42, "x".repeat(9000)]) {
    const res = await post({ ssid });
    assert.equal(res.status, 400, JSON.stringify(ssid).slice(0, 30));
  }
  assert.equal(calls.length, 0);
});

test("each delivered store bumps the global counter and reports it", async () => {
  const DB = fakeDb(41);
  const first = await (await post({ accessToken: TOKEN, region: "na" }, { DB })).json();
  assert.equal(first.shopsChecked, 42);
  const second = await (await post({ ssid: GOOD_SSID, region: "na" }, { DB })).json();
  assert.equal(second.shopsChecked, 43);
});

test("failed checks don't count", async () => {
  const DB = fakeDb(10);
  globalThis.fetch = fakeRiot({ realFetch: null, calls, storeStatus: 401 });
  await post({ accessToken: TOKEN, region: "na" }, { DB });
  await post({ accessToken: "bad" }, { DB });
  assert.equal(DB.n, 10);
});

test("/api/stats reads the count without bumping it, and is cacheable", async () => {
  const DB = fakeDb(7);
  const res = await worker.fetch(new Request("https://shop.test/api/stats"), { DB });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { shopsChecked: 7 });
  assert.match(res.headers.get("Cache-Control"), /max-age=15/);
  assert.equal(DB.n, 7);
});

test("a missing or broken database never costs anyone their store", async () => {
  const none = await (await post({ accessToken: TOKEN, region: "na" })).json();
  assert.equal(none.shopsChecked, null);
  assert.equal(none.daily.offers.length, 4);

  const broken = { prepare: () => ({ first: async () => { throw new Error("D1 down"); } }) };
  const res = await post({ accessToken: TOKEN, region: "na" }, { DB: broken });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).shopsChecked, null);
  const stats = await worker.fetch(new Request("https://shop.test/api/stats"), { DB: broken });
  assert.deepEqual(await stats.json(), { shopsChecked: null });
});

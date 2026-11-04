// A storefront in the v3 shape, built from real item IDs so the page renders
// real names and images when served by the local mock (see test/mock-server.js).
const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
const KC = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";
const SKIN = "e7c63390-eda7-46e0-bb7a-a6abdacd2433";

const skinOffer = (id, price) => ({ OfferID: id, Cost: { [VP]: price }, Rewards: [{ ItemTypeID: SKIN, ItemID: id, Quantity: 1 }] });
const accOffer = (type, id, price) => ({
  Offer: { OfferID: `o-${id}`, Cost: { [KC]: price }, Rewards: [{ ItemTypeID: type, ItemID: id, Quantity: 1 }] },
  ContractID: "c",
});

export const DAILY = [
  ["97855211-4064-4fa5-996c-cc840c587cc8", 2475],
  ["31e19a89-4397-6ccb-47b8-94a6906667a1", 2175],
  ["f5ce6297-4cd4-4b09-3931-5f8b20a4317d", 1775],
  ["e1a05cb4-4ac5-b15a-e86e-bab0f7e093ad", 1275],
];

export const STOREFRONT = {
  FeaturedBundle: {
    Bundles: [
      { DataAssetID: "285ce9b7-4eff-19af-8370-7fb2e62b05c5", CurrencyID: VP, DurationRemainingInSeconds: 500000,
        Items: [{ DiscountedPrice: 1775 }, { DiscountedPrice: 2000 }] },
      { DataAssetID: "0667837d-42f6-a5e9-409a-6eab70b0d330", CurrencyID: VP, DurationRemainingInSeconds: 90000,
        TotalDiscountedCost: { [VP]: 7100 }, Items: [] },
    ],
  },
  SkinsPanelLayout: {
    SingleItemOffers: DAILY.map(([id]) => id),
    SingleItemStoreOffers: DAILY.map(([id, p]) => skinOffer(id, p)),
    SingleItemOffersRemainingDurationInSeconds: 40000,
  },
  AccessoryStore: {
    AccessoryStoreOffers: [
      accOffer("dd3bf334-87f3-40bd-b043-682a57a8dc3a", "427fdd9a-41b7-5adb-729e-9ab323b26061", 2500),
      accOffer("d5f120f8-ff8c-4aac-92ea-f2b5acbe9475", "04251d6a-4548-856b-5ea1-19b01783c430", 2000),
      accOffer("3f296c07-64c3-494c-923b-fe692a4fa1bd", "f32eb1e5-4cd3-0520-88a3-0cafb7423002", 2000),
      accOffer("de7caa6b-adf7-4588-bbd1-143831e786c6", "70b4b892-4cd8-0d62-0976-e4897410bdb0", 1500),
    ],
    AccessoryStoreRemainingDurationInSeconds: 300000,
    StorefrontID: "s",
  },
  BonusStore: {
    BonusStoreOffers: [{
      BonusOfferID: "b1",
      Offer: skinOffer("eae7f96d-42bb-95e8-de62-fb94f0e25696", 875),
      DiscountPercent: 34,
      DiscountCosts: { [VP]: 578 },
      IsSeen: false,
    }],
    BonusStoreRemainingDurationInSeconds: 600000,
  },
};

export const GOOD_SSID = "good-session-cookie-value.abc123";
export const ROTATED_SSID = "rotated-session-cookie-value.def456";

// Stand-in for every Riot endpoint the Worker calls. `calls` records each
// request so tests can assert on headers. Anything else passes through.
export function fakeRiot({ realFetch = globalThis.fetch, calls = [], geo = "eu", storeStatus = 200 } = {}) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const { host, pathname } = new URL(url);
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const record = () => calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });

    if (host === "auth.riotgames.com" && pathname === "/authorize") {
      // Cookie login: GOOD_SSID gets tokens and is rotated to ROTATED_SSID,
      // which then keeps working; anything else is a signed-out session.
      record();
      const cookie = new Headers(init.headers).get("Cookie") ?? "";
      const headers = new Headers();
      if (cookie === `ssid=${GOOD_SSID}` || cookie === `ssid=${ROTATED_SSID}`) {
        headers.set("Location", "http://localhost/redirect#access_token=fresh.access.token&id_token=fresh.id.token&expires_in=3600");
        headers.append("Set-Cookie", "clid=uw1; Path=/; Secure");
        if (cookie === `ssid=${GOOD_SSID}`) headers.append("Set-Cookie", `ssid=${ROTATED_SSID}; Path=/; HttpOnly; Secure`);
      } else {
        headers.set("Location", "http://localhost/redirect#error=interaction_required&error_description=login_required");
      }
      return new Response(null, { status: 303, headers });
    }
    if (host === "entitlements.auth.riotgames.com") { record(); return reply({ entitlements_token: "ent.tok.en" }); }
    if (host === "auth.riotgames.com" && pathname === "/userinfo") {
      record();
      return reply({ sub: "puuid-123", acct: { game_name: "Tester", tag_line: "000" } });
    }
    if (host === "riot-geo.pas.si.riotgames.com") { record(); return reply({ affinities: { pbe: "na", live: geo } }); }
    if (host.endsWith(".a.pvp.net")) { record(); return reply(storeStatus === 200 ? STOREFRONT : {}, storeStatus); }
    if (host === "valorant-api.com" && pathname === "/v1/version" && !realFetch) {
      return reply({ data: { riotClientVersion: "release-test" } });
    }
    return realFetch(input, init);
  };
}

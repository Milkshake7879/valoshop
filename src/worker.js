// Valorant shop checker — the backend half (served as a Pages Function).
//
// The browser cannot call Riot's store servers itself (they send no CORS
// headers), so this Worker does it on the browser's behalf. It is stateless:
// the credentials arrive in the request body, are used for a handful of
// upstream calls, and are never stored or logged. Item names and images are
// resolved in the browser from valorant-api.com, which keeps this Worker's CPU
// time tiny.
//
// Two ways in: an hour-long access token pasted from Riot's redirect URL, or a
// saved `ssid` session cookie ("stay logged in"), which is traded for a fresh
// access token on every request exactly as Riot's own client does.

// Riot's client sends this base64 JSON blob describing the platform; the store
// endpoint rejects requests without it. The value itself is not checked.
const CLIENT_PLATFORM = btoa(JSON.stringify({
  platformType: "PC",
  platformOS: "Windows",
  platformOSVersion: "10.0.19042.1.256.64bit",
  platformChipset: "Unknown",
}));

const USER_AGENT = "ShooterGame/13 Windows/10.0.19042.1.256.64bit";

// Account region (what Riot's geo service reports) -> store shard.
const SHARDS = { na: "na", latam: "na", br: "na", eu: "eu", ap: "ap", kr: "kr" };

// Same login as the page's button, but with prompt=none: given a live session
// cookie Riot redirects straight back with tokens instead of showing a form.
const REAUTH_URL =
  "https://auth.riotgames.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fredirect" +
  "&client_id=riot-client&response_type=token%20id_token&nonce=1&scope=account%20openid&prompt=none";

const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const COOKIE_VALUE = /^[\w.\-]+$/;

class HttpError extends Error {
  // `code` lets the page tell "saved login is dead, forget it" apart from a
  // transient failure that should leave the saved login alone.
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/store") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      return handleStore(request);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function handleStore(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  const { accessToken, idToken, ssid, region } = body ?? {};
  if (ssid != null) {
    if (!isCookieValue(ssid)) return json({ error: "That doesn't look like an ssid cookie value." }, 400);
  } else if (!isJwt(accessToken)) {
    return json({ error: "No access token found. Paste the whole URL Riot sent you to after logging in." }, 400);
  } else if (idToken != null && !isJwt(idToken)) {
    return json({ error: "The id_token in that URL is malformed." }, 400);
  }
  if (region != null && region !== "auto" && !(region in SHARDS)) return json({ error: "Unknown region." }, 400);

  try {
    if (ssid != null) {
      const login = await reauth(ssid);
      const store = await fetchStore(login.accessToken, login.idToken, region);
      return json({ ...store, ssid: login.ssid });
    }
    return json(await fetchStore(accessToken, idToken, region));
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
    return json({ error: "Couldn't reach Riot. Try again in a moment." }, 502);
  }
}

// Trade a session cookie for a fresh access token. Returns the rotated cookie
// when Riot issues a new one, so the page can save it in place of the old.
async function reauth(ssid) {
  const res = await fetch(REAUTH_URL, {
    redirect: "manual",
    headers: { Cookie: `ssid=${ssid}`, "User-Agent": USER_AGENT },
  });
  const location = res.headers.get("Location") ?? "";
  const params = new URLSearchParams(location.split("#")[1] ?? "");
  const accessToken = params.get("access_token");

  if (!accessToken) {
    if (params.get("error")) {
      throw new HttpError(
        401,
        "Your saved login has expired or was signed out. Log in again to stay logged in.",
        "login_expired",
      );
    }
    throw new HttpError(502, `Riot's login service didn't respond as expected (HTTP ${res.status}).`);
  }

  const rotated = res.headers
    .getSetCookie()
    .map((c) => /^ssid=([^;]*)/.exec(c)?.[1])
    .find(Boolean);
  return {
    accessToken,
    idToken: params.get("id_token"),
    ssid: rotated && rotated !== ssid ? rotated : null,
  };
}

async function fetchStore(accessToken, idToken, region) {
  const auth = { Authorization: `Bearer ${accessToken}` };

  const [entitlements, userinfo, version, shard] = await Promise.all([
    riot("https://entitlements.auth.riotgames.com/api/token/v1", "entitlements", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{}",
    }),
    riot("https://auth.riotgames.com/userinfo", "account", { headers: auth }),
    clientVersion(),
    region && region !== "auto" ? SHARDS[region] : detectShard(auth, idToken),
  ]);

  const puuid = userinfo.sub;
  if (typeof puuid !== "string") throw new HttpError(502, "Riot didn't return an account ID.");

  const store = await riot(`https://pd.${shard}.a.pvp.net/store/v3/storefront/${puuid}`, "store", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      "X-Riot-Entitlements-JWT": entitlements.entitlements_token,
      "X-Riot-ClientVersion": version,
      "X-Riot-ClientPlatform": CLIENT_PLATFORM,
    },
    body: "{}",
  });

  return {
    shard,
    gameName: userinfo.acct?.game_name ?? null,
    ...normalizeStore(store),
  };
}

async function detectShard(auth, idToken) {
  if (!idToken) {
    throw new HttpError(400, "Couldn't detect your region from that URL. Pick your region and try again.");
  }
  const geo = await riot("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", "region", {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken }),
  });
  const shard = SHARDS[geo.affinities?.live];
  if (!shard) throw new HttpError(400, "Couldn't detect your region. Pick it manually and try again.");
  return shard;
}

async function clientVersion() {
  // valorant-api.com tracks the live client build; Riot rejects stale versions.
  const res = await fetch("https://valorant-api.com/v1/version", { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new HttpError(502, "Couldn't look up the current game version.");
  const { data } = await res.json();
  return data.riotClientVersion;
}

async function riot(url, step, init) {
  const res = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...init.headers } });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new HttpError(401, "Riot rejected the login. It only lasts an hour, so log in again and paste the new URL.");
  }
  if (!res.ok) throw new HttpError(502, `Riot's ${step} service failed (HTTP ${res.status}). Try again shortly.`);
  return res.json();
}

// --- Shaping the storefront for the page ------------------------------------

export function normalizeStore(store) {
  const daily = store.SkinsPanelLayout ?? {};
  const accessories = store.AccessoryStore ?? {};
  const night = store.BonusStore;
  const featured = store.FeaturedBundle ?? {};

  return {
    daily: {
      remaining: daily.SingleItemOffersRemainingDurationInSeconds ?? null,
      offers: (daily.SingleItemStoreOffers ?? []).map(offer),
    },
    accessories: {
      remaining: accessories.AccessoryStoreRemainingDurationInSeconds ?? null,
      offers: (accessories.AccessoryStoreOffers ?? []).map((o) => offer(o.Offer)),
    },
    nightMarket: night
      ? {
          remaining: night.BonusStoreRemainingDurationInSeconds ?? null,
          offers: (night.BonusStoreOffers ?? []).map((o) => ({
            ...offer(o.Offer),
            discountPercent: o.DiscountPercent ?? 0,
            discounted: firstCost(o.DiscountCosts),
            seen: Boolean(o.IsSeen),
          })),
        }
      : null,
    bundles: (featured.Bundles ?? (featured.Bundle ? [featured.Bundle] : [])).map((b) => ({
      id: b.DataAssetID,
      remaining: b.DurationRemainingInSeconds ?? null,
      cost: firstCost(b.TotalDiscountedCost) ?? sumItems(b.Items, b.CurrencyID),
    })),
  };
}

function offer(o) {
  const reward = o?.Rewards?.[0] ?? {};
  return {
    itemId: reward.ItemID ?? null,
    itemTypeId: reward.ItemTypeID ?? null,
    quantity: reward.Quantity ?? 1,
    cost: firstCost(o?.Cost),
  };
}

function firstCost(costs) {
  const [entry] = Object.entries(costs ?? {});
  return entry ? { currency: entry[0], amount: entry[1] } : null;
}

function sumItems(items, currency) {
  if (!Array.isArray(items) || !currency) return null;
  const amount = items.reduce((sum, i) => sum + (i.DiscountedPrice ?? 0), 0);
  return amount ? { currency, amount } : null;
}

function isJwt(value) {
  return typeof value === "string" && value.length < 8192 && JWT.test(value);
}

function isCookieValue(value) {
  return typeof value === "string" && value.length < 8192 && COOKIE_VALUE.test(value);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

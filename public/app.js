// Valorant shop checker — the page.
//
// Flow: the user logs in on Riot's own page, Riot redirects to a localhost URL
// that fails to load, and the user pastes that URL here. We pull the tokens out
// of its #fragment, send them to /api/store (our Worker), and resolve the item
// IDs it returns into names and images from valorant-api.com.
//
// Pasted tokens live in memory only, so Refresh works until they expire
// (~1 hour) and closing the tab forgets them. "Stay logged in" instead saves
// Riot's ssid session cookie in localStorage; the Worker trades it for fresh
// tokens on every load, and the page saves the rotated cookie Riot sometimes
// sends back. The region choice is remembered either way.

const LOGIN_URL =
  "https://auth.riotgames.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fredirect" +
  "&client_id=riot-client&response_type=token%20id_token&nonce=1&scope=account%20openid";

// Riot's own sign-out page: the fallback if prompt=login is ever ignored. It
// dead-ends with no way onward, so it's only ever opened in a new tab.
const LOGOUT_URL = "https://auth.riotgames.com/logout";

// Any auth.riotgames.com page that doesn't redirect, so the user can read the
// ssid cookie for that origin in developer tools.
const COOKIE_PAGE_URL = "https://auth.riotgames.com/.well-known/openid-configuration";

const API = "https://valorant-api.com/v1";

const CURRENCY = {
  "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": { name: "VP", icon: currencyIcon("85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741") },
  "85ca954a-41f2-ce94-9b45-8ca3dd39a00d": { name: "KC", icon: currencyIcon("85ca954a-41f2-ce94-9b45-8ca3dd39a00d") },
  "e59aa87c-4cbf-517a-5983-6e81511be9b7": { name: "RP", icon: currencyIcon("e59aa87c-4cbf-517a-5983-6e81511be9b7") },
};

// Store item type -> how to look it up on valorant-api.com.
const ITEM_TYPES = {
  "e7c63390-eda7-46e0-bb7a-a6abdacd2433": { label: "Skin", lookup: (id) => skinLevel(id) },
  "dd3bf334-87f3-40bd-b043-682a57a8dc3a": { label: "Gun Buddy", lookup: (id) => simple("buddies/levels", id) },
  "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475": {
    label: "Spray",
    lookup: (id) => simple("sprays", id, (d) => d.fullTransparentIcon ?? d.displayIcon),
  },
  "3f296c07-64c3-494c-923b-fe692a4fa1bd": {
    label: "Player Card",
    lookup: (id) => simple("playercards", id, (d) => d.largeArt ?? d.displayIcon),
  },
  "de7caa6b-adf7-4588-bbd1-143831e786c6": {
    label: "Title",
    lookup: (id) => simple("playertitles", id, () => null, (d) => d.titleText ?? d.displayName),
  },
  "03a572de-4234-31ed-d344-ababa488f981": { label: "Flex", lookup: (id) => simple("flex", id) },
};

const $ = (id) => document.getElementById(id);

let session = null;      // { accessToken, idToken } or { ssid, persist }
let hasStore = false;    // a store is on screen, so a refresh keeps it visible
let timers = {};         // section -> absolute end time (ms)
let tick = null;
let skinIndexPromise = null;
const revealed = new Set(); // Night Market offers already flipped this visit

// --- Startup -----------------------------------------------------------------

$("riot-login").href = LOGIN_URL;
// prompt=login (listed in Riot's OpenID config) makes Riot show its login form
// even when it remembers an account, instead of redirecting straight back.
$("switch-account").href = `${LOGIN_URL}&prompt=login`;
$("riot-logout").href = LOGOUT_URL;
$("riot-cookie-page").href = COOKIE_PAGE_URL;
$("region").value = loadPref("region") ?? "auto";
$("region").addEventListener("change", () => savePref("region", $("region").value));

// Opening Riot's login moves the guide on, so step 2 is waiting on return.
for (const id of ["riot-login", "switch-account"]) {
  $(id).addEventListener("click", () => setTimeout(() => setStep(2), 250));
}
$("have-link").addEventListener("click", () => setStep(2));
$("back").addEventListener("click", () => setStep(1));

$("phone-help-toggle").addEventListener("click", () => {
  const open = $("phone-help").hidden;
  $("phone-help").hidden = !open;
  $("phone-help-toggle").setAttribute("aria-expanded", String(open));
});

// A valid address submits itself the moment it lands in the box.
$("paste").addEventListener("input", () => tryTokens($("paste").value, { quiet: true }));
$("paste-form").addEventListener("submit", (e) => {
  e.preventDefault();
  tryTokens($("paste").value);
});

$("paste-clipboard").addEventListener("click", async () => {
  try {
    const clip = await navigator.clipboard.readText();
    $("paste").value = clip;
    tryTokens(clip);
  } catch {
    $("paste").focus();
    showError("Your browser didn't share the clipboard. Long-press the box and choose Paste.");
  }
});

$("open-stay").addEventListener("click", () => $("stay-dialog").showModal());

$("ssid-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const ssid = parseSsid($("ssid").value);
  if (!ssid) {
    showError("That doesn't look like an ssid cookie. Copy the whole value of the ssid row.");
    return;
  }
  $("ssid").value = "";
  $("stay-dialog").close();
  // Saved only once Riot accepts it, so a typo never sticks.
  session = { ssid, persist: true };
  load();
});

$("refresh").addEventListener("click", () => load());
$("logout").addEventListener("click", () => logout());
$("error-close").addEventListener("click", () => showError(null));
$("reveal-all").addEventListener("click", () => {
  document.querySelectorAll("#night .flip:not(.revealed)").forEach((card, i) => {
    setTimeout(() => reveal(card), i * 140);
  });
});

const savedSsid = loadPref("ssid");
if (savedSsid) {
  session = { ssid: savedSsid, persist: true };
  load();
}

// Warm the skin index while the user is off logging in.
skinIndex().catch(() => {});

// --- Login guide -------------------------------------------------------------

function setStep(n) {
  $("wizard").dataset.step = String(n);
  if (n === 2 && matchMedia("(hover: hover)").matches) $("paste").focus();
}

function tryTokens(text, { quiet = false } = {}) {
  const tokens = parseTokens(text);
  if (!tokens) {
    if (!quiet && text.trim()) showError("That's not the right address. It should contain #access_token=…");
    return;
  }
  $("paste").value = "";
  session = tokens;
  load();
}

function parseTokens(text) {
  const raw = text.trim();
  if (!raw) return null;
  const hash = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  if (!accessToken) return null;
  return { accessToken, idToken: params.get("id_token") };
}

// Accepts the bare value, `ssid=value`, or a value copied with quotes.
function parseSsid(text) {
  const value = text.trim().replace(/^ssid=/, "").replace(/^"|"$/g, "").replace(/;.*$/, "");
  return /^[\w.\-]{20,}$/.test(value) ? value : null;
}

// --- Fetching ----------------------------------------------------------------

async function load() {
  if (!session) return;
  showError(null);
  if (!hasStore) showSkeleton();
  setBusy(true);
  try {
    const credentials = session.ssid
      ? { ssid: session.ssid }
      : { accessToken: session.accessToken, idToken: session.idToken };
    const res = await fetch("/api/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentials, region: $("region").value }),
    });
    const data = await res.json().catch(() => ({ error: "Unexpected response from the server." }));
    if (!res.ok) {
      // A dead saved login is forgotten; anything else (Riot hiccup, wrong
      // region) leaves it saved so the next visit can try again.
      if (data.code === "login_expired" || (res.status === 401 && !session.ssid)) logout();
      throw new Error(data.error ?? `Request failed (HTTP ${res.status}).`);
    }
    if (session.ssid) {
      if (data.ssid) session.ssid = data.ssid;
      if (session.persist && !savePref("ssid", session.ssid)) {
        showError("Couldn't save your login in this browser (private browsing?). It'll last until you close the tab.");
      }
    }
    await render(data);
  } catch (err) {
    if (!hasStore) showLogin();
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

function logout() {
  session = null;
  removePref("ssid");
  showLogin();
}

function showLogin() {
  hasStore = false;
  clearInterval(tick);
  $("store").hidden = true;
  $("account").hidden = true;
  $("login").hidden = false;
  setStep(1);
}

function setBusy(busy) {
  $("refresh").setAttribute("aria-busy", String(busy));
  $("paste-clipboard").disabled = busy;
  $("ssid-submit").disabled = busy;
}

// --- Rendering ---------------------------------------------------------------

function showSkeleton() {
  $("login").hidden = true;
  $("store").hidden = false;
  $("night-panel").hidden = true;
  $("bundles-panel").hidden = true;
  for (const node of document.querySelectorAll("[data-timer]")) node.textContent = "";
  fill("daily", Array.from({ length: 4 }, (_, i) => skeletonCard(i)));
  fill("accessories", Array.from({ length: 4 }, (_, i) => skeletonCard(i)));
}

async function render(store) {
  const now = Date.now();
  timers = {
    daily: endsAt(now, store.daily.remaining),
    accessories: endsAt(now, store.accessories.remaining),
    night: endsAt(now, store.nightMarket?.remaining),
  };

  const [daily, accessories, night, bundles] = await Promise.all([
    Promise.all(store.daily.offers.map(resolveOffer)),
    Promise.all(store.accessories.offers.map(resolveOffer)),
    Promise.all((store.nightMarket?.offers ?? []).map(resolveOffer)),
    Promise.all(store.bundles.map(resolveBundle)),
  ]);

  fill("daily", daily.map((item, i) => stagger(skinCard(item), i)));
  fill("accessories", accessories.map((item, i) => stagger(accessoryCard(item), i)));
  fill("night", night.map((item, i) => stagger(nightCard(item), i)));
  fill("bundles", bundles.map((b, i) => stagger(bundleCard(b), i)));
  $("night-panel").hidden = night.length === 0;
  $("bundles-panel").hidden = bundles.length === 0;
  $("reveal-all").hidden = night.every((item) => revealed.has(item.itemId));

  $("account-name").textContent = store.gameName ?? "Player";
  $("saved-dot").hidden = !session?.ssid;
  $("account").hidden = false;
  $("login").hidden = true;
  $("store").hidden = false;
  hasStore = true;

  updateTimers();
  clearInterval(tick);
  tick = setInterval(updateTimers, 1000);
}

function stagger(node, i) {
  node.style.setProperty("--d", `${i * 70}ms`);
  return node;
}

function skeletonCard(i) {
  const card = stagger(el("div", "card skeleton"), i);
  card.setAttribute("aria-hidden", "true");
  card.append(el("div", "art"), el("div", "meta", null, [el("div", "bar short"), el("div", "bar wide"), el("div", "bar short")]));
  return card;
}

function skinCard(item) {
  const card = el("article", "card skin");
  if (item.tier) card.style.setProperty("--tier", item.tier.color);

  const art = el("div", "art");
  if (item.icon) art.append(img(item.icon, item.name));
  card.append(art);
  if (item.discountPercent) card.append(el("span", "discount", `−${item.discountPercent}%`));

  const meta = el("div", "meta");
  if (item.tier) {
    const tier = el("span", "tier");
    tier.append(img(item.tier.icon, ""), text(item.tier.name));
    meta.append(tier);
  }
  meta.append(el("h3", "name", item.name));

  const price = el("div", "price");
  if (item.discounted) {
    price.append(el("s", "was", formatAmount(item.cost)), costTag(item.discounted));
  } else if (item.cost) {
    price.append(costTag(item.cost));
  }
  meta.append(price);
  card.append(meta);
  return card;
}

// Night Market offers start face down, as in the game.
function nightCard(item) {
  const card = el("article", "card flip");
  const inner = el("div", "flip-inner");

  const back = el("button", "flip-face back");
  back.type = "button";
  back.setAttribute("aria-label", "Reveal this Night Market offer");
  back.append(el("span", "emblem"), text("Tap to reveal"));
  back.addEventListener("click", () => reveal(card));

  const front = skinCard(item);
  front.classList.add("flip-face", "front");

  inner.append(back, front);
  card.append(inner);
  card.dataset.item = item.itemId ?? "";
  if (revealed.has(item.itemId)) card.classList.add("revealed");
  return card;
}

function reveal(card) {
  card.classList.add("revealed");
  revealed.add(card.dataset.item);
  if (!document.querySelector("#night .flip:not(.revealed)")) $("reveal-all").hidden = true;
}

function accessoryCard(item) {
  const card = el("article", "card acc");
  const art = el("div", "art");
  if (item.icon) art.append(img(item.icon, item.name));
  else art.append(el("span", "title-art", item.name));
  card.append(art);

  const meta = el("div", "meta");
  meta.append(el("span", "kind", item.label), el("h3", "name", item.name));
  if (item.cost) meta.append(el("div", "price", null, [costTag(item.cost)]));
  card.append(meta);
  return card;
}

function bundleCard(bundle) {
  const card = el("article", "card bundle");
  const art = el("div", "art");
  if (bundle.icon) art.append(img(bundle.icon, bundle.name));
  card.append(art);

  const meta = el("div", "meta");
  meta.append(el("h3", "name", bundle.name));
  meta.append(el("div", "price", null, bundle.cost ? [costTag(bundle.cost)] : []));
  if (bundle.end) {
    const t = el("span", "timer");
    t.dataset.end = String(bundle.end);
    t.dataset.label = "Leaves in";
    meta.append(t);
  }
  card.append(meta);
  return card;
}

function costTag(cost) {
  const c = CURRENCY[cost.currency];
  const tag = el("span", "cost");
  if (c) tag.append(img(c.icon, c.name));
  tag.append(text(formatAmount(cost)));
  return tag;
}

function formatAmount(cost) {
  return cost ? cost.amount.toLocaleString() : "";
}

function updateTimers() {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-timer]")) {
    node.textContent = countdown(timers[node.dataset.timer], now, "Resets in");
  }
  for (const node of document.querySelectorAll("[data-end]")) {
    node.textContent = countdown(Number(node.dataset.end), now, node.dataset.label);
  }
}

// Game-style: "Resets in 11:06:37" under a day, "Resets in 3D 11H" over.
function countdown(end, now, label) {
  if (!end) return "";
  const s = Math.max(0, Math.round((end - now) / 1000));
  if (s === 0) return "New offers — refresh";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return d ? `${label} ${d}D ${h}H` : `${label} ${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

function endsAt(now, seconds) {
  return typeof seconds === "number" ? now + seconds * 1000 : null;
}

// --- Item lookups (valorant-api.com) ----------------------------------------

async function resolveOffer(offer) {
  const type = ITEM_TYPES[offer.itemTypeId];
  let info = null;
  try {
    info = type ? await type.lookup(offer.itemId) : null;
  } catch {
    // Fall through to the placeholder below.
  }
  return {
    ...offer,
    label: type?.label ?? "Item",
    name: info?.name ?? "Unknown item",
    icon: info?.icon ?? null,
    tier: info?.tier ?? null,
  };
}

async function resolveBundle(bundle) {
  let info = null;
  try {
    info = await getData(`bundles/${bundle.id}`);
  } catch {
    // Placeholder below.
  }
  return {
    name: info?.displayName ?? "Bundle",
    icon: info?.displayIcon ?? null,
    cost: bundle.cost,
    end: endsAt(Date.now(), bundle.remaining),
  };
}

// Skin levels carry no tier, so we index the full skin list once per visit
// (≈450 KB gzipped; valorant-api.com lets the browser cache it for 4 hours).
function skinIndex() {
  skinIndexPromise ??= Promise.all([getData("weapons/skins"), getData("contenttiers")])
    .then(([skins, tiers]) => {
      const tierById = new Map(
        tiers.map((t) => [t.uuid, { name: t.devName, icon: t.displayIcon, color: `#${t.highlightColor.slice(0, 6)}` }]),
      );
      const byLevel = new Map();
      for (const skin of skins) {
        const tier = tierById.get(skin.contentTierUuid) ?? null;
        const fallbackIcon = skin.chromas?.[0]?.fullRender ?? skin.displayIcon;
        for (const level of skin.levels ?? []) {
          byLevel.set(level.uuid, { name: skin.displayName, icon: level.displayIcon ?? fallbackIcon, tier });
        }
      }
      return byLevel;
    })
    .catch((err) => {
      skinIndexPromise = null;
      throw err;
    });
  return skinIndexPromise;
}

async function skinLevel(id) {
  return (await skinIndex()).get(id) ?? null;
}

async function simple(path, id, icon = (d) => d.displayIcon, name = (d) => d.displayName) {
  const d = await getData(`${path}/${id}`);
  return { name: name(d), icon: icon(d) };
}

async function getData(path) {
  const res = await fetch(`${API}/${path}`);
  if (!res.ok) throw new Error(`valorant-api.com ${path}: HTTP ${res.status}`);
  return (await res.json()).data;
}

function currencyIcon(id) {
  return `https://media.valorant-api.com/currencies/${id}/displayicon.png`;
}

// --- DOM helpers (no innerHTML: names come from a third-party API) -----------

function el(tag, className, content, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  if (children) node.append(...children);
  return node;
}

function img(src, alt) {
  const node = document.createElement("img");
  node.src = src;
  node.alt = alt;
  node.loading = "lazy";
  node.decoding = "async";
  return node;
}

function text(value) {
  return document.createTextNode(value);
}

function fill(id, nodes) {
  $(id).replaceChildren(...nodes);
}

function showError(message) {
  $("error").hidden = !message;
  $("error-text").textContent = message ?? "";
}

function loadPref(key) {
  try {
    return localStorage.getItem(`shop:${key}`);
  } catch {
    return null;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`shop:${key}`, value);
    return true;
  } catch {
    // Private mode etc. — the preference just won't stick.
    return false;
  }
}

function removePref(key) {
  try {
    localStorage.removeItem(`shop:${key}`);
  } catch {
    // Nothing was saved, then.
  }
}

"use strict";

/* global CookieWallet */

const $ = (id) => document.getElementById(id);
const QUOTE_REFRESH_MS = 30_000;
const POPULAR = ["BTC", "ETH", "XMR", "SOL", "USDT-TRON", "USDC-ETH"];

const state = {
  assets: [], health: null, info: null, prices: {},
  from: "BTC", to: "XMR",
  slippageBps: null, // null = server default ("Auto")
  quote: null, quoteError: null, quoting: false, quoteSeq: 0, creating: false,
  invertRate: false, picking: null,
  order: null, token: null, poll: null, tick: null, lastOrder: null,
};

// ---------------------------------------------------------------- helpers
/** Per-browser conveniences only (pair, slippage, recent orders); the app works without storage. */
const store = {
  get(key, dflt) {
    try {
      const v = localStorage.getItem(`cookieswap.${key}`);
      return v === null ? dflt : JSON.parse(v);
    } catch {
      return dflt;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`cookieswap.${key}`, JSON.stringify(value));
    } catch { /* private mode or blocked storage */ }
  },
};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** Tiny DOM builder: el("p", { class: "x" }, "text", child). Text is always set via textContent. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  for (const c of children) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function icon(name, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function fmt(n, max = 8) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  return v.toLocaleString(undefined, { maximumFractionDigits: max });
}

/** Amounts: 6 significant digits below 1, up to 6 decimals above, 2 above 10k. */
function fmtAmount(n) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  if (v === 0) return "0";
  if (v >= 10_000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return v.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

function fmtUsd(v) {
  if (!isFinite(v)) return "";
  if (v > 0 && v < 0.01) return "< $0.01";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usd(n) {
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Basis points -> "1%" / "0.5%". */
function pct(bps) {
  return `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function eta(seconds) {
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

function minutes(seconds) {
  return seconds < 90 ? `~${Math.round(seconds)} sec` : `~${Math.round(seconds / 60)} min`;
}

function short(addr, head = 6, tail = 4) {
  return addr && addr.length > head + tail + 1 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr || "";
}

/** Exact decimal string -> integer units (no floating point). */
function toUnits(str, decimals) {
  const [whole, frac = ""] = String(str).split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function fromUnits(units, decimals, maxFrac = decimals) {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${u / base}${frac ? `.${frac}` : ""}`;
}

const assetById = (id) => state.assets.find((a) => a.id === id);
const symbolOf = (id) => (assetById(id) || { symbol: id }).symbol;
const effectiveSlippage = () => state.slippageBps ?? (state.info ? state.info.slippage.defaultBps : 200);

function amountValue() {
  const v = $("amount").value.trim().replace(",", ".");
  return v && Number(v) > 0 ? v : "";
}

function usdOf(id, amount) {
  const p = state.prices[id];
  const v = Number(amount);
  return p && isFinite(v) ? p * v : NaN;
}

// ---------------------------------------------------------------- token icons
const COLORS = {
  BTC: "#f7931a", ETH: "#627eea", XMR: "#ff6600", USDT: "#26a17b", USDC: "#2775ca", DAI: "#f5ac37",
  BNB: "#f0b90b", XRP: "#4b5b6c", SOL: "#9945ff", TRX: "#ef0027", ZEC: "#e5a93d", DOGE: "#c2a633",
  LINK: "#2a5ada", ADA: "#0033ad", XLM: "#3e7bd6", BCH: "#0ac18e", LTC: "#345d9d", UNI: "#ff007a",
  AVAX: "#e84142", SUI: "#4da2ff",
};
const GLYPH = {
  BTC: "₿", ETH: "Ξ", XMR: "ɱ", USDT: "₮", USDC: "$", DAI: "◈", LTC: "Ł", DOGE: "Ð", SOL: "◎", ADA: "₳", XRP: "✕", ZEC: "ⓩ",
};
const CHAIN_COLOR = {
  ETH: COLORS.ETH, BSC: COLORS.BNB, POL: "#8247e5", BASE: "#0052ff", ARB: "#28a0f0", AVAX: COLORS.AVAX, TRON: COLORS.TRX, SOL: COLORS.SOL,
};

function tokenIcon(a, size = "md") {
  const glyph = GLYPH[a.symbol] || a.symbol.slice(0, a.symbol.length > 4 ? 1 : 2);
  const s = el("span", { class: `tok tok-${size}${glyph.length > 1 ? " tok-text" : ""}`, "aria-hidden": "true" }, glyph);
  s.style.setProperty("--c", COLORS[a.symbol] || "#a98c72");
  if (a.token) {
    const dot = el("span", { class: "tok-chain" });
    dot.style.setProperty("--c", CHAIN_COLOR[a.chain] || "#777");
    s.append(dot);
  }
  return s;
}

/** Short network label for badges ("TRC-20", "Base", "Bitcoin"). */
function netLabel(a) {
  return a.code || a.network.replace(/ \(.*\)$/, "");
}

// ---------------------------------------------------------------- toasts
function toast(message, kind = "info", ms = 3800) {
  const t = el("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" },
    icon(kind === "ok" ? "check" : kind === "err" ? "info" : "info"), el("span", {}, message));
  $("toasts").append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    t.addEventListener("transitionend", () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 600);
  }, ms);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, "ok", 2000);
  } catch {
    toast("Copy failed: select the text and copy it manually", "err");
  }
}

function flash(node, cls = "pulse") {
  node.classList.remove(cls);
  void node.offsetWidth; // restart the animation
  node.classList.add(cls);
}

// ---------------------------------------------------------------- info / FAQ
function routesText(info) {
  const r = info.routes;
  return r.length > 1 ? `${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}` : r.join("");
}

function listFrom(items, ordered = false) {
  return el(ordered ? "ol" : "ul", {}, ...items.map((i) => el("li", {}, i)));
}

function tableFrom(head, rows) {
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, c)))))));
}

function faqItem(question, ...body) {
  return el("details", { class: "faq" },
    el("summary", {}, el("span", {}, question), icon("chevron", "chev")),
    el("div", { class: "faq-body" }, ...body));
}

function renderInfo(info) {
  const stables = state.assets.filter((a) => a.stable);
  const bySymbol = {};
  for (const a of stables) (bySymbol[a.symbol] ||= []).push(netLabel(a));
  const coins = state.assets.filter((a) => !a.stable);
  const sendCoins = coins.filter((a) => a.canSend).map((a) => a.symbol);
  const receiveOnly = coins.filter((a) => !a.canSend).map((a) => a.symbol);
  const stableNames = Object.keys(bySymbol).join(", ").replace(/, ([^,]*)$/, " or $1");
  const symbols = new Set(state.assets.map((a) => a.symbol));

  $("tagline").textContent =
    `${symbols.size} coins, stablecoins on ${new Set(stables.map((a) => a.chain)).size} networks. Every quote compares ${routesText(info)} and takes the best rate.`;

  const stat = (value, label) => el("div", { class: "stat" }, el("strong", {}, value), el("span", {}, label));
  $("stats").replaceChildren(
    stat(String(symbols.size), "coins"),
    stat(String(info.routes.length), "DEX routes compared"),
    stat(pct(info.fees.swapBps), "fee per swap"),
    stat("0", "accounts needed"),
  );

  const feeRows = [
    ["Every swap", pct(info.fees.swapBps)],
    [`Receiving ${stableNames}`, pct(info.fees.stablePayoutBps)],
  ];
  if (info.fees.inventorySpreadBps > 0) feeRows.push(["Swaps paid from our XMR inventory (spread)", `+${pct(info.fees.inventorySpreadBps)}`]);
  feeRows.push(["Network fee", "Gas to forward your deposit, shown in your quote"]);
  feeRows.push(["Exchange costs", "Already included in the rate you see"]);

  $("faq").replaceChildren(
    faqItem("How does it work?", listFrom([
      "Choose what you send and what you want to receive. You get a live quote with the rate, our fee, the network fee, the minimum you receive and the estimated time.",
      "Enter your receive address, and a refund address on the network you send from.",
      `Send exactly the shown amount to your one-time deposit address within ${info.depositWindowMinutes} minutes, from any wallet or exchange (or with a connected EVM wallet in one click).`,
      "When your deposit is confirmed, we swap it through the best route and send the result straight to your address.",
    ], true)),
    faqItem("What does it cost?",
      tableFrom(["", "Fee"], feeRows),
      el("p", {}, "Our fee is taken from your deposit and shown in every quote. There are no other fees.")),
    faqItem("How long does it take?",
      tableFrom(["Network you send on", "We wait for", "Typical wait"],
        info.networks.map((n) => [n.network, n.confirmations, minutes(n.typicalSeconds)])),
      el("p", {}, `After that the swap itself usually takes a few minutes, depending on the route. Swaps above ${usd(info.limits.manualReviewUsd)} take longer, because we check them by hand first.`)),
    faqItem("What is slippage tolerance?",
      el("p", {}, `Rates aren't locked while you send your deposit. When it confirms we fetch a fresh rate; if that is worse than your quote by more than your slippage tolerance, you get a refund instead. The default is ${pct(info.slippage.defaultBps)}; you can pick ${pct(info.slippage.minBps)}–${pct(info.slippage.maxBps)} under the settings icon. A tight tolerance protects the rate but makes a refund more likely.`)),
    faqItem("Are there limits?", listFrom([
      `Minimum about ${usd(info.limits.minUsd)}, maximum about ${usd(info.limits.maxUsd)} per swap.`,
      `Swaps above ${usd(info.limits.manualReviewUsd)} are checked by hand after your deposit confirms, before they run.`,
      "Some routes have their own minimum. If your amount is too small, the quote tells you.",
    ])),
    faqItem("What if something goes wrong?", listFrom([
      "If the rate moves beyond your slippage tolerance before your deposit confirms, we refund you instead of swapping.",
      "If no route is available, or a deposit fails our checks, we send it back to your refund address, minus the network fee.",
      `A deposit that arrives after the ${info.depositWindowMinutes}-minute window is reviewed by hand.`,
      "Tokens sent on the wrong network may not be recoverable. Always check the network shown on the deposit screen.",
    ])),
    faqItem("Do you hold my funds?",
      el("p", {}, "Yes, for the duration of the swap. cookieswap is a custodial service: your deposit goes to an address we control and stays there until it is swapped or refunded. We don't issue wrapped tokens, and we keep our hot wallet balances small."),
      el("p", {}, "Before the swap runs, your deposit is checked by our AML compliance screening. If the check fails, we don't swap: your crypto is refunded to your refund address, minus the network fee.")),
    faqItem("Do I need to connect a wallet?",
      el("p", {}, "No. Connecting an EVM wallet is optional: it fills in your addresses, shows your balance and can send the deposit for you. cookieswap never asks for a signature, a token approval or your keys.")),
    faqItem("What do you store about me?",
      el("p", {}, `No account and no IP addresses. An order only holds what's needed to complete it: addresses, amounts and transaction ids. Finished orders are deleted after ${info.retentionDays} days. Your order link contains a private key, so anyone with the link can see that order's status.`)),
    faqItem("Which coins and networks are supported?", listFrom([
      `Send and receive: ${sendCoins.join(", ")}.`,
      ...Object.entries(bySymbol).map(([sym, nets]) => `${sym} on ${nets.join(", ")}.`),
      ...(receiveOnly.length ? [`Receive only for now: ${receiveOnly.join(", ")}.`] : []),
    ])),
    faqItem("Which exchanges do you use?",
      el("p", {}, `Every quote compares ${routesText(info)} and picks the one that gives you the most. Monero is paid from our own inventory, because no decentralized exchange lists native XMR right now.`)),
  );
  $("info").hidden = false;
}

// ---------------------------------------------------------------- token buttons & panels
function renderTokenButton(btn, a) {
  btn.replaceChildren(
    tokenIcon(a, "md"),
    el("span", { class: "tb-text" }, el("span", { class: "tb-sym" }, a.symbol), el("span", { class: "tb-net" }, netLabel(a))),
    icon("chevron", "chev"),
  );
}

function renderPair() {
  const f = assetById(state.from);
  const t = assetById(state.to);
  renderTokenButton($("from-token"), f);
  renderTokenButton($("to-token"), t);
  $("from-network").textContent = `on ${f.network}`;
  $("to-network").textContent = `on ${t.network}`;
  $("recipient-label").textContent = `Your ${t.symbol} address`;
  $("refund-label").textContent = `Refund address (${f.symbol} on ${netLabel(f)})`;
  $("recipient").placeholder = `${t.symbol} address on ${t.network}`;
  $("refund").placeholder = `${f.symbol} address on ${f.network}, in case we must refund`;
  $("memo-warning").hidden = !t.memoWarning;
  $("memo-warning").textContent = t.memoWarning
    ? `Use a personal ${t.symbol} wallet. We can't add a destination tag or memo, so an exchange deposit address that needs one may lose the funds.`
    : "";
  store.set("pair", [state.from, state.to]);
  updateWalletChips();
  updateUsd();
  refreshBalances();
}

function updateUsd() {
  const amount = amountValue();
  const fromUsd = amount ? usdOf(state.from, amount) : NaN;
  $("from-usd").textContent = isFinite(fromUsd) ? `≈ ${fmtUsd(fromUsd)}` : "";
  const out = state.quote ? state.quote.amountOut : "";
  const toUsd = out ? usdOf(state.to, out) : NaN;
  const span = $("to-usd");
  span.replaceChildren();
  if (isFinite(toUsd)) {
    span.append(`≈ ${fmtUsd(toUsd)}`);
    if (isFinite(fromUsd) && fromUsd > 0) {
      const diff = (toUsd / fromUsd - 1) * 100;
      span.append(" ", el("span", { class: `diff${diff < -5 ? " bad" : ""}`, title: "Value difference including all fees" },
        `(${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%)`));
    }
  }
}

function selectToken(side, id) {
  if (side === "from") {
    if (id === state.to) state.to = state.from;
    state.from = id;
  } else {
    if (id === state.from) {
      const prevTo = assetById(state.to);
      state.from = prevTo.canSend ? prevTo.id : state.assets.find((a) => a.canSend && a.id !== id).id;
    }
    state.to = id;
  }
  const fromChain = assetById(state.from).chain;
  const toChain = assetById(state.to).chain;
  // An address for another network is never right: clear fields whose network changed.
  if ($("refund").dataset.chain && $("refund").dataset.chain !== fromChain) $("refund").value = "";
  if ($("recipient").dataset.chain && $("recipient").dataset.chain !== toChain) $("recipient").value = "";
  $("refund").dataset.chain = fromChain;
  $("recipient").dataset.chain = toChain;
  renderPair();
  invalidateQuote();
  scheduleQuote(0);
}

function flip() {
  const t = assetById(state.to);
  const btn = $("flip");
  if (!t.canSend) {
    flash(btn, "shake");
    toast(`${t.symbol} can only be received for now`, "warn");
    return;
  }
  flash(btn, "spin");
  const out = state.quote ? state.quote.amountOut : "";
  [state.from, state.to] = [state.to, state.from];
  // The receive address becomes the refund address and vice versa: they're on the swapped networks.
  const r = $("recipient").value;
  $("recipient").value = $("refund").value;
  $("refund").value = r;
  $("refund").dataset.chain = assetById(state.from).chain;
  $("recipient").dataset.chain = assetById(state.to).chain;
  if (out) $("amount").value = trimAmount(out, assetById(state.from).decimals);
  renderPair();
  invalidateQuote();
  scheduleQuote(0);
}

function trimAmount(v, decimals) {
  const [w, f = ""] = String(v).split(".");
  const frac = f.slice(0, Math.min(decimals, 8)).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w;
}

// ---------------------------------------------------------------- token picker
function openTokenModal(side) {
  state.picking = side;
  $("token-title").textContent = side === "from" ? "You send" : "You receive";
  $("token-search").value = "";
  renderTokenList();
  $("token-modal").showModal();
  $("token-search").focus();
}

function matches(a, q) {
  if (!q) return true;
  const hay = `${a.symbol} ${a.name} ${a.network} ${a.code || ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function sortedAssets() {
  return [...state.assets].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.symbol.localeCompare(b.symbol) || a.network.localeCompare(b.network));
}

function renderTokenList() {
  const side = state.picking;
  const q = $("token-search").value.trim();
  const current = side === "from" ? state.from : state.to;
  const usable = (a) => side === "to" || a.canSend;

  $("token-popular").replaceChildren(...POPULAR.map(assetById).filter(Boolean).map((a) =>
    el("button", { type: "button", class: `pop-chip${a.id === current ? " selected" : ""}`, "data-id": a.id, disabled: !usable(a) },
      tokenIcon(a, "xs"), a.symbol, a.code ? el("span", { class: "pop-net" }, a.code) : null)));
  $("token-popular").hidden = !!q;

  const rows = sortedAssets().filter((a) => matches(a, q)).map((a) => {
    const price = state.prices[a.id];
    return el("li", {},
      el("button", {
        type: "button", class: `token-row${a.id === current ? " selected" : ""}`, role: "option",
        "aria-selected": a.id === current ? "true" : "false", "data-id": a.id, disabled: !usable(a),
      },
      tokenIcon(a, "lg"),
      el("span", { class: "tr-main" },
        el("span", { class: "tr-sym" }, a.symbol, el("span", { class: "net-badge" }, netLabel(a))),
        el("span", { class: "tr-name" }, a.name)),
      el("span", { class: "tr-side" },
        !usable(a) ? el("span", { class: "tag" }, "Receive only")
          : a.id === current ? icon("check", "tr-check")
          : price ? el("span", { class: "tr-price" }, fmtUsd(price)) : null)));
  });
  $("token-list").replaceChildren(...rows);
  $("token-empty").hidden = rows.length > 0;
}

function pickFromModal(id) {
  const side = state.picking;
  $("token-modal").close();
  if (!id) return;
  const a = assetById(id);
  if (side === "from" && !a.canSend) return;
  selectToken(side, id);
}

// ---------------------------------------------------------------- quote
let quoteTimer = null;
let refreshTimer = null;

function invalidateQuote() {
  state.quote = null;
  state.quoteError = null;
  updateButton();
}

function scheduleQuote(delay = 350) {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => getQuote(), delay);
}

function startRefreshRing() {
  const ring = $("ring");
  $("refresh").hidden = false;
  ring.classList.remove("run");
  void ring.getBoundingClientRect();
  ring.classList.add("run");
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!$("swap").hidden && !document.hidden && !$("token-modal").open) getQuote({ silent: true });
    else startRefreshRing();
  }, QUOTE_REFRESH_MS);
}

function stopRefreshRing() {
  clearTimeout(refreshTimer);
  $("refresh").hidden = true;
}

async function getQuote({ silent = false } = {}) {
  const amount = amountValue();
  const seq = ++state.quoteSeq;
  $("quote-error").hidden = true;
  if (!amount || state.from === state.to) {
    state.quote = null;
    state.quoteError = null;
    $("out").textContent = "0";
    $("to-panel").classList.remove("loading");
    $("details").hidden = true;
    $("q-review").hidden = true;
    stopRefreshRing();
    updateUsd();
    updateButton();
    return;
  }
  state.quoting = true;
  if (!silent) {
    $("to-panel").classList.add("loading");
    updateButton();
  }
  try {
    const recipient = $("recipient").value.trim() || undefined;
    const q = await api("/api/quote", {
      method: "POST",
      body: JSON.stringify({ from: state.from, to: state.to, amount, recipient, slippageBps: state.slippageBps ?? undefined }),
    });
    if (seq !== state.quoteSeq) return;
    state.quote = q.best;
    state.quoteError = null;
    state.alternatives = q.alternatives.length;
    renderQuote(silent);
    startRefreshRing();
  } catch (e) {
    if (seq !== state.quoteSeq) return;
    state.quote = null;
    state.quoteError = e.message;
    $("out").textContent = "0";
    $("details").hidden = true;
    $("q-review").hidden = true;
    $("quote-error").textContent = e.message;
    $("quote-error").hidden = false;
    stopRefreshRing();
  } finally {
    if (seq === state.quoteSeq) {
      state.quoting = false;
      $("to-panel").classList.remove("loading");
      updateUsd();
      updateButton();
    }
  }
}

function renderRate() {
  const b = state.quote;
  if (!b) return;
  const fs = symbolOf(state.from);
  const ts = symbolOf(state.to);
  $("d-rate").textContent = state.invertRate
    ? `1 ${ts} = ${fmtAmount(1 / b.rate)} ${fs}`
    : `1 ${fs} = ${fmtAmount(b.rate)} ${ts}`;
}

function renderQuote(silent) {
  const b = state.quote;
  const fs = symbolOf(state.from);
  const ts = symbolOf(state.to);
  $("out").textContent = fmtAmount(b.amountOut);
  if (silent) flash($("out"), "tick");
  renderRate();
  $("d-eta").lastElementChild.textContent = eta(b.etaSeconds);
  $("q-fee-label").textContent = `Our fee (${pct(b.feeBps)}${b.spreadBps ? ` + ${pct(b.spreadBps)} spread` : ""})`;
  $("q-fee").textContent = `${fmtAmount(b.serviceFee)} ${fs}`;
  $("q-netfee").textContent = `${fmtAmount(b.networkFee)} ${fs}`;
  $("q-netfee-row").hidden = Number(b.networkFee) === 0;
  $("q-slip").textContent = `${pct(b.slippageBps)}${state.slippageBps === null ? " (auto)" : ""}`;
  $("q-min").textContent = `${fmtAmount(b.guaranteedMin)} ${ts}`;
  $("q-route").textContent = state.alternatives ? `${b.routeName} · best of ${state.alternatives + 1}` : b.routeName;
  $("q-eta").textContent = eta(b.etaSeconds);
  $("q-note").textContent = `Rates aren't locked. We check the rate again when your deposit confirms; if it is more than ${pct(b.slippageBps)} worse, you get a refund instead.`;
  $("details").hidden = false;
  $("q-review").textContent = `Swaps above ${usd(state.health.manualReviewUsd)} are checked by hand after your deposit confirms, before the swap runs. This can add some time.`;
  $("q-review").hidden = !b.manualReview;
}

function updateButton() {
  const btn = $("create");
  const amount = amountValue();
  let label;
  let ready = false;
  if (state.creating) label = "Creating your swap…";
  else if (!amount) label = "Enter an amount";
  else if (state.from === state.to) label = "Pick two different tokens";
  else if (state.quoting && !state.quote) label = "Finding the best rate…";
  else if (!state.quote) label = state.quoteError ? "No route for this amount" : "Finding the best rate…";
  else if (!$("recipient").value.trim()) label = `Enter your ${symbolOf(state.to)} address`;
  else if (!$("refund").value.trim()) label = `Enter a ${symbolOf(state.from)} refund address`;
  else {
    label = `Swap ${symbolOf(state.from)} to ${symbolOf(state.to)}`;
    ready = true;
  }
  $("create-label").textContent = label;
  btn.disabled = !ready;
  btn.classList.toggle("busy", state.creating || (state.quoting && !state.quote));
}

async function createOrder() {
  state.creating = true;
  updateButton();
  try {
    const res = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        from: state.from,
        to: state.to,
        amount: amountValue(),
        recipient: $("recipient").value.trim(),
        refundAddress: $("refund").value.trim(),
        slippageBps: state.slippageBps ?? undefined,
      }),
    });
    rememberOrder(res.order, res.token);
    history.pushState(null, "", `#order=${res.order.id}.${res.token}`);
    showOrder(res.order.id, res.token, res.order);
  } catch (e) {
    $("quote-error").textContent = e.message;
    $("quote-error").hidden = false;
    toast(e.message, "err");
  } finally {
    state.creating = false;
    updateButton();
  }
}

// ---------------------------------------------------------------- slippage settings
const SLIP_PRESETS = [null, 50, 100, 300];

function renderSlippage() {
  const info = state.info;
  const presets = $("slip-presets");
  // Built once and updated in place: replacing the clicked button would detach the click target.
  if (!presets.children.length) {
    presets.append(...SLIP_PRESETS.map((bps) => el("button", { type: "button", role: "radio", class: "seg-btn", "data-bps": bps === null ? "auto" : String(bps) },
      bps === null ? `Auto ${pct(info.slippage.defaultBps)}` : pct(bps))));
  }
  for (const b of presets.children) {
    const on = (b.dataset.bps === "auto" ? null : Number(b.dataset.bps)) === state.slippageBps;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  }
  const custom = state.slippageBps !== null && !SLIP_PRESETS.includes(state.slippageBps);
  if (!custom && document.activeElement !== $("slip-input")) $("slip-input").value = "";
  $("slip-input").parentElement.classList.toggle("active", custom);
  const chip = $("slip-chip");
  chip.hidden = state.slippageBps === null;
  chip.textContent = state.slippageBps === null ? "" : pct(state.slippageBps);
  const hint = $("slip-hint");
  const eff = effectiveSlippage();
  hint.className = "hint warn";
  hint.hidden = !(eff < 50 || eff > 300);
  hint.textContent = eff < 50
    ? "Very tight: a small market move before your deposit confirms will refund the swap."
    : "Loose: you could receive noticeably less than quoted.";
}

function setSlippage(bps) {
  state.slippageBps = bps;
  store.set("slippage", bps);
  renderSlippage();
  if (state.quote || state.quoteError) scheduleQuote(0);
}

function onSlipInput() {
  const raw = $("slip-input").value.trim().replace(",", ".");
  if (!raw) return setSlippage(null);
  const v = Number(raw);
  const { minBps, maxBps } = state.info.slippage;
  const bps = Math.round(v * 100);
  if (!isFinite(v) || bps < minBps || bps > maxBps) {
    const hint = $("slip-hint");
    hint.className = "hint err";
    hint.hidden = false;
    hint.textContent = `Enter between ${pct(minBps)} and ${pct(maxBps)}.`;
    return;
  }
  setSlippage(bps);
}

// ---------------------------------------------------------------- popovers
function togglePopover(id, btnId, open) {
  const pop = $(id);
  const show = open ?? pop.hidden;
  closePopovers();
  pop.hidden = !show;
  $(btnId).setAttribute("aria-expanded", String(show));
  if (show) requestAnimationFrame(() => pop.classList.add("in"));
}

function closePopovers() {
  for (const [id, btn] of [["settings", "settings-btn"], ["recent", "recent-btn"]]) {
    $(id).hidden = true;
    $(id).classList.remove("in");
    $(btn).setAttribute("aria-expanded", "false");
  }
}

// ---------------------------------------------------------------- recent orders
function recentOrders() {
  const list = store.get("orders", []);
  return Array.isArray(list) ? list : [];
}

function rememberOrder(o, token) {
  const list = recentOrders().filter((r) => r.id !== o.id);
  list.unshift({ id: o.id, token, from: o.from, to: o.to, amount: o.depositAmount, at: Date.now() });
  store.set("orders", list.slice(0, 8));
  renderRecent();
}

function renderRecent() {
  const list = recentOrders();
  $("recent-count").hidden = list.length === 0;
  $("recent-count").textContent = String(list.length);
  $("recent-list").replaceChildren(...(list.length ? list.map((r) => {
    const f = assetById(r.from);
    const t = assetById(r.to);
    return el("li", {}, el("a", { href: `#order=${r.id}.${r.token}`, class: "recent-item" },
      el("span", { class: "pair-icons" }, f ? tokenIcon(f, "sm") : null, t ? tokenIcon(t, "sm") : null),
      el("span", { class: "ri-main" },
        el("span", {}, `${fmtAmount(r.amount)} ${symbolOf(r.from)} → ${symbolOf(r.to)}`),
        el("span", { class: "fine" }, new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })))));
  }) : [el("li", { class: "fine empty" }, "No swaps yet in this browser.")]));
}

// ---------------------------------------------------------------- wallet
function evmAsset(a) {
  return a && a.evm;
}

function updateWalletUi() {
  const w = CookieWallet.current;
  const btn = $("wallet-btn");
  btn.classList.toggle("connected", !!w);
  $("wallet-label").textContent = w ? short(w.address, 6, 4) : "Connect wallet";
  updateWalletChips();
  refreshBalances();
  if (state.lastOrder) renderSendWallet(state.lastOrder);
  if ($("wallet-modal").open) renderWalletModal();
}

function updateWalletChips() {
  const w = CookieWallet.current;
  $("recipient-wallet").hidden = !(w && evmAsset(assetById(state.to)));
  $("refund-wallet").hidden = !(w && evmAsset(assetById(state.from)));
}

function walletIcon(info) {
  const box = el("span", { class: "wl-icon" });
  if (info.icon && info.icon.startsWith("data:image/")) {
    const img = el("img", { src: info.icon, alt: "", width: "28", height: "28" });
    img.addEventListener("error", () => img.replaceWith(icon("wallet")));
    box.append(img);
  } else {
    box.append(icon("wallet"));
  }
  return box;
}

function renderWalletModal() {
  const w = CookieWallet.current;
  $("wallet-title").textContent = w ? "Wallet connected" : "Connect a wallet";
  $("wallet-connected").hidden = !w;
  const wallets = CookieWallet.list();
  $("wallet-list").hidden = !!w;
  $("wallet-empty").hidden = !!w || wallets.length > 0;
  if (w) {
    $("wc-icon").replaceChildren(walletIcon(w.info));
    $("wc-address").textContent = short(w.address, 10, 8);
    const chain = CookieWallet.CHAINS[w.chainId];
    $("wc-chain").textContent = `${w.info.name} · ${chain ? chain.name : `chain ${w.chainId}`}`;
    return;
  }
  $("wallet-list").replaceChildren(...wallets.map((entry) => el("li", {},
    el("button", { type: "button", class: "wallet-row", "data-uuid": entry.info.uuid },
      walletIcon(entry.info), el("span", {}, entry.info.name), icon("chevron", "chev-right")))));
}

async function connectWallet(uuid) {
  const entry = CookieWallet.list().find((e) => e.info.uuid === uuid);
  if (!entry) return;
  try {
    await CookieWallet.connect(entry);
    $("wallet-modal").close();
    toast(`Connected ${entry.info.name}`, "ok");
    autofillFromWallet();
  } catch (e) {
    toast(e.message || "Connection rejected", "err");
  }
}

/** Fill empty EVM address fields with the connected account (never overwrites what the user typed). */
function autofillFromWallet() {
  const w = CookieWallet.current;
  if (!w) return;
  if (evmAsset(assetById(state.to)) && !$("recipient").value.trim()) $("recipient").value = w.address;
  if (evmAsset(assetById(state.from)) && !$("refund").value.trim()) $("refund").value = w.address;
  updateButton();
}

let balanceSeq = 0;
async function readBalance(a) {
  return a.token ? CookieWallet.tokenBalance(a.token) : CookieWallet.nativeBalance();
}

async function refreshBalances() {
  const seq = ++balanceSeq;
  const w = CookieWallet.current;
  for (const side of ["from", "to"]) {
    const a = assetById(state[side]);
    const box = $(`${side}-balance`);
    if (!w || !a || !evmAsset(a) || !a.evmChainId) {
      box.hidden = true;
      continue;
    }
    box.hidden = false;
    if (w.chainId !== a.evmChainId) {
      box.replaceChildren(side === "from"
        ? el("button", { type: "button", class: "link-btn", "data-switch": String(a.evmChainId) }, `Switch to ${netLabel(a)}`)
        : el("span", {}, ""));
      continue;
    }
    try {
      const units = await readBalance(a);
      if (seq !== balanceSeq) return;
      const shown = fromUnits(units, a.decimals, 6);
      box.replaceChildren(
        icon("wallet"), el("span", {}, fmtAmount(shown)),
        side === "from" && units > 0n ? el("button", { type: "button", class: "max-btn", "data-max": "1" }, "Max") : null);
      box.dataset.units = units.toString();
    } catch {
      if (seq !== balanceSeq) return;
      box.hidden = true;
    }
  }
}

async function useMax() {
  const a = assetById(state.from);
  const units = BigInt($("from-balance").dataset.units || "0");
  let spendable = units;
  if (!a.token) {
    // Keep enough for the wallet's own transfer gas (2x a plain transfer at today's gas price).
    const gas = 21_000n * (await CookieWallet.gasPrice()) * 2n;
    spendable = units > gas ? units - gas : 0n;
  }
  if (spendable <= 0n) return toast("Not enough left after network fees", "warn");
  $("amount").value = fromUnits(spendable, a.decimals, Math.min(a.decimals, 8));
  onAmountInput();
}

async function switchTo(chainId) {
  try {
    await CookieWallet.switchChain(chainId);
  } catch (e) {
    toast(e.message || "Network switch rejected", "err");
  }
}

// ---------------------------------------------------------------- order view
const STEP_INDEX = { awaiting_deposit: 0, confirming: 1, manual_review: 2, processing: 2, completed: 3 };
const STATUS_TEXT = {
  awaiting_deposit: ["Waiting for your deposit.", "", "Awaiting deposit"],
  confirming: ["Deposit received, waiting for confirmations.", "", "Confirming"],
  manual_review: ["Deposit confirmed. Large swaps are checked by hand before they run; we will execute or refund it.", "warn", "Manual review"],
  processing: ["Swapping your funds through the best route.", "", "Swapping"],
  completed: ["Done! Your funds are on their way to your address.", "ok", "Completed"],
  refunding: ["Refunding to your refund address.", "warn", "Refunding"],
  refunded: ["Refunded to your refund address.", "warn", "Refunded"],
  expired: ["Expired: no deposit arrived in time.", "err", "Expired"],
  under_review: ["Under review by the operator. Your funds are safe; we will complete or refund manually.", "warn", "Under review"],
};

function showView(view) {
  $("swap").hidden = view !== "swap";
  $("hero").hidden = view !== "swap";
  $("order").hidden = view !== "order";
  $("nav-swap").classList.toggle("active", view === "swap");
  for (const id of [view]) flash($(id), "enter");
}

function showOrder(id, token, initial) {
  state.order = id;
  state.token = token;
  state.lastOrder = null;
  stopRefreshRing();
  showView("order");
  $("dev").hidden = !(state.health && state.health.chains === "mock");
  $("qr").src = `/api/orders/${id}/qr.svg?token=${encodeURIComponent(token)}`;
  $("o-pair").replaceChildren();
  if (initial) renderOrder(initial);
  clearInterval(state.poll);
  clearInterval(state.tick);
  state.poll = setInterval(refreshOrder, 5000);
  state.tick = setInterval(renderExpiry, 1000);
  refreshOrder();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showSwap() {
  clearInterval(state.poll);
  clearInterval(state.tick);
  state.order = null;
  state.lastOrder = null;
  showView("swap");
  if (state.quote) startRefreshRing();
}

async function refreshOrder() {
  if (!state.order) return;
  try {
    const o = await api(`/api/orders/${state.order}`, { headers: { "x-order-token": state.token } });
    renderOrder(o);
  } catch (e) {
    $("o-status").textContent = e.message;
    $("o-status").className = "status err";
  }
}

function renderExpiry() {
  const o = state.lastOrder;
  if (!o || o.status !== "awaiting_deposit") return;
  const left = Math.max(0, o.expiresAt - Date.now());
  const total = Math.max(1, o.expiresAt - o.createdAt);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  $("d-expiry").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  $("d-expiry-bar").style.width = `${(left / total) * 100}%`;
  $("d-expiry").parentElement.classList.toggle("urgent", left < 5 * 60_000);
}

function renderSendWallet(o) {
  const a = assetById(o.from);
  const btn = $("send-wallet");
  const possible = o.status === "awaiting_deposit" && a && a.evm && a.evmChainId && CookieWallet.list().length > 0;
  btn.hidden = !possible;
  if (!possible) return;
  const w = CookieWallet.current;
  const sent = store.get(`sent.${o.id}`, null);
  btn.disabled = !!sent;
  $("send-wallet-label").textContent = sent ? "Sent from your wallet" : !w ? "Connect wallet to send"
    : w.chainId !== a.evmChainId ? `Switch to ${netLabel(a)} & send` : `Send ${fmtAmount(o.depositAmount)} ${a.symbol} with wallet`;
}

async function sendWithWallet() {
  const o = state.lastOrder;
  const a = assetById(o.from);
  if (!CookieWallet.current) {
    renderWalletModal();
    $("wallet-modal").showModal();
    return;
  }
  const btn = $("send-wallet");
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    await CookieWallet.switchChain(a.evmChainId);
    const units = toUnits(o.depositAmount, a.decimals);
    const tx = a.token
      ? await CookieWallet.sendToken(a.token, o.depositAddress, units)
      : await CookieWallet.sendNative(o.depositAddress, units);
    store.set(`sent.${o.id}`, tx);
    toast(`Deposit sent: ${short(tx, 10, 6)}`, "ok", 6000);
  } catch (e) {
    toast(e.message || "Transaction rejected", "err");
  } finally {
    btn.classList.remove("busy");
    renderSendWallet(o);
  }
}

function renderOrder(o) {
  const prev = state.lastOrder;
  state.lastOrder = o;
  const done = ["completed", "refunded", "expired"].includes(o.status);
  const from = assetById(o.from);
  const to = assetById(o.to);

  if (!prev || prev.id !== o.id) {
    $("o-pair").replaceChildren(
      el("span", { class: "op-side" }, from ? tokenIcon(from, "md") : null, el("strong", {}, `${fmtAmount(o.depositAmount)} ${symbolOf(o.from)}`)),
      icon("swap", "op-arrow"),
      el("span", { class: "op-side" }, to ? tokenIcon(to, "md") : null, el("strong", {}, `${o.amountOut ? "" : "≈ "}${fmtAmount(o.amountOut || o.quotedOut)} ${symbolOf(o.to)}`)));
  }

  $("deposit-box").hidden = o.status !== "awaiting_deposit";
  $("d-amount").textContent = `${o.depositAmount} ${symbolOf(o.from)}`;
  $("d-address").textContent = o.depositAddress;
  $("d-network").textContent = from && from.token
    ? `Only send ${symbolOf(o.from)} on ${o.fromNetwork}. Tokens sent on another network cannot be recovered.`
    : `Network: ${o.fromNetwork}`;
  $("d-network").className = from && from.token ? "notice" : "fine";
  renderExpiry();
  renderSendWallet(o);

  const idx = STEP_INDEX[o.status];
  const steps = $("steps");
  steps.classList.toggle("halted", idx === undefined);
  steps.dataset.progress = String(idx === undefined ? 0 : o.status === "completed" ? 3 : idx);
  for (const li of steps.children) {
    const i = STEP_INDEX[li.dataset.step];
    li.className = idx === undefined ? "" : i < idx || o.status === "completed" ? "done" : i === idx ? "active" : "";
  }
  const [text, cls, pill] = STATUS_TEXT[o.status] || [o.status, "", o.status];
  $("o-status").textContent = text;
  $("o-status").className = `status ${cls}`;
  $("o-pill").textContent = pill;
  $("o-pill").className = `pill ${cls}`;
  if (prev && prev.id === o.id && prev.status !== o.status) {
    flash($("o-pill"), "pop");
    if (o.status === "completed") toast("Swap completed", "ok");
  }

  const out = o.amountOut || o.quotedOut;
  $("o-out").textContent = `${o.amountOut ? "" : "≈ "}${fmtAmount(out)} ${symbolOf(o.to)} (${o.toNetwork})`;
  $("o-recipient").textContent = o.recipient;
  $("o-route").textContent = o.routeName;
  $("o-slip-row").hidden = o.slippageBps === null;
  $("o-slip").textContent = o.slippageBps === null ? "" : pct(o.slippageBps);
  $("o-id").textContent = o.id;
  $("o-payout-row").hidden = !o.payoutTxid;
  $("o-payout").textContent = o.payoutTxid || "";
  $("o-refund-row").hidden = !o.refundTxid;
  $("o-refund").textContent = o.refundTxid || "";
  if (done) {
    clearInterval(state.poll);
    clearInterval(state.tick);
  }
}

async function simulateDeposit() {
  $("dev-msg").textContent = "";
  try {
    const r = await api("/admin/mock/deposit", {
      method: "POST",
      headers: { authorization: `Bearer ${$("admin-token").value}` },
      body: JSON.stringify({ orderId: state.order }),
    });
    $("dev-msg").textContent = `Simulated deposit ${r.txid.slice(0, 16)}…`;
    refreshOrder();
  } catch (e) {
    $("dev-msg").textContent = e.message;
  }
}

// ---------------------------------------------------------------- routing
function route() {
  const m = location.hash.match(/^#order=([0-9a-f]+)\.([\w-]+)$/);
  if (m) {
    if (state.order !== m[1]) showOrder(m[1], m[2]);
  } else if (state.order) {
    showSwap();
  }
}

// ---------------------------------------------------------------- input handling
function onAmountInput() {
  const input = $("amount");
  const a = assetById(state.from);
  let v = input.value.replace(",", ".").replace(/[^0-9.]/g, "");
  const dot = v.indexOf(".");
  if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "").slice(0, a.decimals);
  if (v.startsWith(".")) v = `0${v}`;
  if (v !== input.value) input.value = v;
  invalidateQuote();
  updateUsd();
  scheduleQuote();
}

async function loadPrices() {
  try {
    state.prices = await api("/api/prices");
    updateUsd();
  } catch {
    // USD values are decoration only; the swap works without them.
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  [state.assets, state.health, state.info] = await Promise.all([api("/api/assets"), api("/api/health"), api("/api/info")]);
  renderInfo(state.info);
  loadPrices();
  setInterval(loadPrices, 60_000);

  const badges = $("badges");
  const badge = (text) => badges.append(el("span", { class: "badge warn" }, text));
  if (state.health.network !== "mainnet") badge(state.health.network);
  if (state.health.chains === "mock") badge("mock chains");
  if (state.health.dryRun) badge("dry run");

  const [f, t] = store.get("pair", ["BTC", "XMR"]);
  const fa = assetById(f);
  const ta = assetById(t);
  state.from = fa && fa.canSend ? f : "BTC";
  state.to = ta && t !== state.from ? t : state.from === "XMR" ? "BTC" : "XMR";
  const slip = store.get("slippage", null);
  const { minBps, maxBps } = state.info.slippage;
  state.slippageBps = Number.isInteger(slip) && slip >= minBps && slip <= maxBps ? slip : null;
  $("refund").dataset.chain = assetById(state.from).chain;
  $("recipient").dataset.chain = assetById(state.to).chain;
  renderPair();
  renderSlippage();
  renderRecent();
  updateButton();

  // swap form
  $("amount").addEventListener("input", onAmountInput);
  $("from-token").addEventListener("click", () => openTokenModal("from"));
  $("to-token").addEventListener("click", () => openTokenModal("to"));
  $("flip").addEventListener("click", flip);
  $("recipient").addEventListener("input", () => { updateButton(); });
  $("recipient").addEventListener("change", () => { if (state.quote) scheduleQuote(0); });
  $("refund").addEventListener("input", updateButton);
  $("create").addEventListener("click", createOrder);
  $("refresh").addEventListener("click", () => getQuote({ silent: true }));
  $("details-toggle").addEventListener("click", (e) => {
    if (e.target.closest("#d-rate")) {
      state.invertRate = !state.invertRate;
      renderRate();
      return;
    }
    const open = $("details").classList.toggle("open");
    $("details-toggle").setAttribute("aria-expanded", String(open));
  });
  $("q-slip").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover("settings", "settings-btn", true);
  });

  // balances / wallet chips (delegated)
  for (const side of ["from", "to"]) {
    $(`${side}-balance`).addEventListener("click", (e) => {
      const sw = e.target.closest("[data-switch]");
      if (sw) return switchTo(Number(sw.dataset.switch));
      if (e.target.closest("[data-max]")) useMax();
    });
  }
  $("recipient-wallet").addEventListener("click", () => {
    $("recipient").value = CookieWallet.current.address;
    updateButton();
  });
  $("refund-wallet").addEventListener("click", () => {
    $("refund").value = CookieWallet.current.address;
    updateButton();
  });

  // token modal
  const tm = $("token-modal");
  $("token-search").addEventListener("input", renderTokenList);
  $("token-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Without this the same keypress re-activates the token button that gets focus back on close.
      e.preventDefault();
      const first = $("token-list").querySelector("button:not([disabled])");
      if (first) pickFromModal(first.dataset.id);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = $("token-list").querySelector("button:not([disabled])");
      if (first) first.focus();
    }
  });
  $("token-list").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...$("token-list").querySelectorAll("button:not([disabled])")];
    const i = rows.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? rows[i + 1] : i <= 0 ? $("token-search") : rows[i - 1];
    if (next) next.focus();
  });
  tm.addEventListener("click", (e) => {
    if (e.target === tm || e.target.closest("[data-close]")) return tm.close();
    const b = e.target.closest("button[data-id]");
    if (b && !b.disabled) pickFromModal(b.dataset.id);
  });

  // wallet modal
  const wm = $("wallet-modal");
  $("wallet-btn").addEventListener("click", () => {
    renderWalletModal();
    wm.showModal();
  });
  wm.addEventListener("click", (e) => {
    if (e.target === wm || e.target.closest("[data-close]")) return wm.close();
    const row = e.target.closest("[data-uuid]");
    if (row) connectWallet(row.dataset.uuid);
  });
  $("wc-copy").addEventListener("click", () => copyText(CookieWallet.current.address, "Address"));
  $("wc-disconnect").addEventListener("click", () => {
    CookieWallet.disconnect();
    wm.close();
    toast("Wallet disconnected");
  });
  CookieWallet.onChange(updateWalletUi);
  CookieWallet.restore().then((w) => { if (w) autofillFromWallet(); });

  // settings + recent popovers
  $("settings-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover("settings", "settings-btn");
  });
  $("settings-close").addEventListener("click", closePopovers);
  $("slip-presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bps]");
    if (!b) return;
    $("slip-input").value = "";
    setSlippage(b.dataset.bps === "auto" ? null : Number(b.dataset.bps));
  });
  $("slip-input").addEventListener("input", onSlipInput);
  $("slip-input").addEventListener("blur", renderSlippage);
  $("recent-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    renderRecent();
    togglePopover("recent", "recent-btn");
  });
  $("recent-clear").addEventListener("click", () => {
    store.set("orders", []);
    renderRecent();
  });
  $("recent-list").addEventListener("click", closePopovers);
  document.addEventListener("click", (e) => {
    const inside = e.composedPath().some((n) => n.classList && (n.classList.contains("settings-wrap") || n.classList.contains("recent-wrap")));
    if (!inside) closePopovers();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopovers();
  });

  // order view
  $("copy").addEventListener("click", () => copyText($("d-address").textContent, "Address"));
  $("copy-amount").addEventListener("click", () => copyText(state.lastOrder.depositAmount, "Amount"));
  $("send-wallet").addEventListener("click", sendWithWallet);
  $("new").addEventListener("click", () => {
    history.pushState(null, "", location.pathname);
    showSwap();
  });
  $("simulate").addEventListener("click", simulateDeposit);

  // navigation
  $("home-link").addEventListener("click", (e) => {
    e.preventDefault();
    if (state.order) {
      history.pushState(null, "", location.pathname);
      showSwap();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("nav-swap").addEventListener("click", (e) => {
    e.preventDefault();
    if (state.order) {
      history.pushState(null, "", location.pathname);
      showSwap();
    }
    $("swap").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("nav-faq").addEventListener("click", (e) => {
    e.preventDefault();
    $("info").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("popstate", route);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.quote && !$("swap").hidden) getQuote({ silent: true });
  });

  route();
  document.body.classList.add("ready");
}

boot().catch((e) => {
  document.body.classList.add("ready");
  $("quote-error").textContent = `Failed to load: ${e.message}`;
  $("quote-error").hidden = false;
});

"use strict";

const $ = (id) => document.getElementById(id);
const state = { assets: [], health: null, quoteSeq: 0, order: null, token: null, poll: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function fmt(n, max = 8) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  return v.toLocaleString(undefined, { maximumFractionDigits: max });
}

function eta(seconds) {
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

function assetById(id) {
  return state.assets.find((a) => a.id === id);
}

/** Basis points -> "1%" / "0.5%". */
function pct(bps) {
  return `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function usd(n) {
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Tiny DOM builder: el("p", { class: "x" }, "text", child). Text is always set via textContent. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function listFrom(items, ordered = false) {
  return el(ordered ? "ol" : "ul", {}, ...items.map((i) => el("li", {}, i)));
}

function tableFrom(head, rows) {
  return el("table", {},
    el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, c))))));
}

function faqItem(question, ...body) {
  return el("details", { class: "faq" }, el("summary", {}, question), el("div", { class: "faq-body" }, ...body));
}

// ---------------------------------------------------------------- info / FAQ
function routesText(info) {
  const r = info.routes;
  return r.length > 1 ? `${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}` : r.join("");
}

function minutes(seconds) {
  return seconds < 90 ? `~${Math.round(seconds)} sec` : `~${Math.round(seconds / 60)} min`;
}

function renderInfo(info) {
  const stables = state.assets.filter((a) => a.code);
  const bySymbol = {};
  for (const a of stables) (bySymbol[a.symbol] ||= []).push(a.network);
  const sendCoins = state.assets.filter((a) => a.canSend && !a.code).map((a) => a.symbol);
  const receiveOnly = state.assets.filter((a) => !a.canSend).map((a) => a.symbol);
  const stableNames = Object.keys(bySymbol).join(", ").replace(/, ([^,]*)$/, " or $1");

  $("tagline").textContent =
    `Swap ${sendCoins.join(", ")} and stablecoins on ${stables.length} networks. Every quote compares ${routesText(info)} and uses the best rate. No account needed.`;

  const feeRows = [
    ["Every swap", pct(info.fees.swapBps)],
    [`Receiving ${stableNames}`, pct(info.fees.stablePayoutBps)],
  ];
  if (info.fees.inventorySpreadBps > 0) feeRows.push(["Swaps paid from our XMR inventory (spread)", `+${pct(info.fees.inventorySpreadBps)}`]);
  feeRows.push(["Network fee", "Gas to forward your deposit, shown in your quote"]);
  feeRows.push(["Exchange costs", "Already included in the rate you see"]);

  const faq = $("faq");
  faq.replaceChildren(
    faqItem("How does it work?", listFrom([
      "Choose what you send and what you want to receive. You get a live quote with the rate, our fee, the network fee, the minimum you receive and the estimated time.",
      "Enter your receive address, and a refund address on the network you send from.",
      `Send exactly the shown amount to your one-time deposit address within ${info.depositWindowMinutes} minutes.`,
      "When your deposit is confirmed, we swap it through the best route and send the result straight to your address.",
    ], true)),
    faqItem("What does it cost?",
      tableFrom(["", "Fee"], feeRows),
      el("p", {}, "Our fee is taken from your deposit and shown in every quote. There are no other fees.")),
    faqItem("How long does it take?",
      tableFrom(["Network you send on", "We wait for", "Typical wait"],
        info.networks.map((n) => [n.network, n.confirmations, minutes(n.typicalSeconds)])),
      el("p", {}, `After that the swap itself usually takes a few minutes, depending on the route. Swaps above ${usd(info.limits.manualReviewUsd)} take longer, because we check them by hand first.`)),
    faqItem("Are there limits?", listFrom([
      `Minimum about ${usd(info.limits.minUsd)}, maximum about ${usd(info.limits.maxUsd)} per swap.`,
      `Swaps above ${usd(info.limits.manualReviewUsd)} are checked by hand after your deposit confirms, before they run.`,
      "Some routes have their own minimum, such as USDT on Tron through NEAR Intents. If your amount is too small, the quote tells you.",
    ])),
    faqItem("What if something goes wrong?", listFrom([
      `If the rate gets more than ${pct(info.maxRateDriftBps)} worse before your deposit confirms, we refund you instead of swapping.`,
      "If no route is available, or a deposit fails our checks, we send it back to your refund address, minus the network fee.",
      `A deposit that arrives after the ${info.depositWindowMinutes}-minute window is reviewed by hand.`,
      "Tokens sent on the wrong network may not be recoverable. Always check the network shown on the deposit screen.",
    ])),
    faqItem("Do you hold my funds?",
      el("p", {}, "Yes, for the duration of the swap. cookieswap is a custodial service: your deposit goes to an address we control and stays there until it is swapped or refunded. We don't issue wrapped tokens, and we keep our hot wallet balances small.")),
    faqItem("What do you store about me?",
      el("p", {}, `No account and no IP addresses. An order only holds what's needed to complete it: addresses, amounts and transaction ids. Finished orders are deleted after ${info.retentionDays} days. Your order link contains a private key, so anyone with the link can see that order's status.`)),
    faqItem("Which coins and networks are supported?",
      listFrom([
        `Send and receive: ${sendCoins.join(", ")}.`,
        ...Object.entries(bySymbol).map(([sym, nets]) => `${sym} on ${nets.join(", ")}.`),
        ...(receiveOnly.length ? [`Receive only: ${receiveOnly.join(", ")}.`] : []),
      ])),
    faqItem("Which exchanges do you use?",
      el("p", {}, `Every quote compares ${routesText(info)} and picks the one that gives you the most. Monero is paid from our own inventory, because no decentralized exchange lists native XMR right now.`)),
  );
  $("info").hidden = false;
}

// ---------------------------------------------------------------- swap form
function fillSelects() {
  const from = $("from");
  const to = $("to");
  const label = (a) => (a.code ? `${a.symbol} · ${a.code}` : a.symbol);
  for (const a of state.assets) {
    if (a.canSend) from.add(new Option(label(a), a.id));
    to.add(new Option(label(a), a.id));
  }
  from.value = "BTC";
  to.value = "XMR";
  updateLabels();
}

function onNetwork(a) {
  return a.token ? `${a.name} on ${a.network}` : a.name;
}

function updateLabels() {
  const f = assetById($("from").value);
  const t = assetById($("to").value);
  $("from-network").textContent = `Network: ${f.network}`;
  $("to-network").textContent = `Network: ${t.network}`;
  $("recipient-label").textContent = `Receive address (${onNetwork(t)})`;
  $("refund-label").textContent = `Refund address (${onNetwork(f)})`;
}

let quoteTimer = null;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(getQuote, 350);
}

async function getQuote() {
  const amount = $("amount").value.trim().replace(",", ".");
  const from = $("from").value;
  const to = $("to").value;
  const seq = ++state.quoteSeq;
  $("quote-error").hidden = true;
  if (!amount || Number(amount) <= 0 || from === to) {
    $("out").textContent = "—";
    $("quote").hidden = true;
    validateForm();
    return;
  }
  $("out").textContent = "…";
  try {
    const recipient = $("recipient").value.trim() || undefined;
    const q = await api("/api/quote", { method: "POST", body: JSON.stringify({ from, to, amount, recipient }) });
    if (seq !== state.quoteSeq) return;
    const b = q.best;
    $("out").textContent = fmt(b.amountOut);
    const fs = symbolOf(from);
    const ts = symbolOf(to);
    $("q-rate").textContent = `1 ${fs} ≈ ${fmt(b.rate, 6)} ${ts}`;
    $("q-fee-label").textContent = `Our fee (${pct(b.feeBps)}${b.spreadBps ? ` + ${pct(b.spreadBps)} spread` : ""})`;
    $("q-fee").textContent = `${fmt(b.serviceFee)} ${fs}`;
    $("q-netfee").textContent = `${fmt(b.networkFee)} ${fs}`;
    $("q-netfee-row").hidden = Number(b.networkFee) === 0;
    $("q-min").textContent = `${fmt(b.minAmountOut)} ${ts}`;
    $("q-route").textContent = b.routeName;
    $("q-eta").textContent = eta(b.etaSeconds);
    $("quote").hidden = false;
    if (state.info) {
      $("q-note").textContent = `Rates aren't locked. We check the rate again when your deposit confirms. If it is more than ${pct(state.info.maxRateDriftBps)} worse than this quote, you get a refund instead.`;
      $("q-note").hidden = false;
    }
    $("q-review").textContent = `Orders above $${state.health.manualReviewUsd} are checked by hand after your deposit confirms, before the swap runs. This can add some time.`;
    $("q-review").hidden = !b.manualReview;
    state.lastQuote = b;
  } catch (e) {
    if (seq !== state.quoteSeq) return;
    $("out").textContent = "—";
    $("quote").hidden = true;
    $("q-note").hidden = true;
    $("q-review").hidden = true;
    $("quote-error").textContent = e.message;
    $("quote-error").hidden = false;
    state.lastQuote = null;
  }
  validateForm();
}

function validateForm() {
  const ok = !!state.lastQuote && $("recipient").value.trim() && $("refund").value.trim();
  $("create").disabled = !ok;
}

async function createOrder() {
  $("create").disabled = true;
  try {
    const res = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        from: $("from").value,
        to: $("to").value,
        amount: $("amount").value.trim().replace(",", "."),
        recipient: $("recipient").value.trim(),
        refundAddress: $("refund").value.trim(),
      }),
    });
    location.hash = `order=${res.order.id}.${res.token}`;
    showOrder(res.order.id, res.token, res.order);
  } catch (e) {
    $("quote-error").textContent = e.message;
    $("quote-error").hidden = false;
    validateForm();
  }
}

// ---------------------------------------------------------------- order view
const STEP_INDEX = { awaiting_deposit: 0, confirming: 1, manual_review: 2, processing: 2, completed: 3 };
const STATUS_TEXT = {
  awaiting_deposit: ["Waiting for your deposit.", ""],
  confirming: ["Deposit received, waiting for confirmations.", ""],
  manual_review: ["Deposit confirmed. Large orders are checked by hand before the swap runs; we will execute or refund it.", "warn"],
  processing: ["Swapping your funds.", ""],
  completed: ["Completed. Funds sent to your address.", "ok"],
  refunding: ["Refunding to your refund address.", "warn"],
  refunded: ["Refunded to your refund address.", "warn"],
  expired: ["Expired: no deposit received in time.", "err"],
  under_review: ["Under review by the operator. Your funds are safe; we will complete or refund manually.", "warn"],
};

function showOrder(id, token, initial) {
  state.order = id;
  state.token = token;
  $("swap").hidden = true;
  $("order").hidden = false;
  $("dev").hidden = !(state.health && state.health.chains === "mock");
  $("qr").src = `/api/orders/${id}/qr.svg?token=${encodeURIComponent(token)}`;
  if (initial) renderOrder(initial);
  clearInterval(state.poll);
  state.poll = setInterval(refreshOrder, 5000);
  refreshOrder();
}

async function refreshOrder() {
  try {
    const o = await api(`/api/orders/${state.order}`, { headers: { "x-order-token": state.token } });
    renderOrder(o);
  } catch (e) {
    $("o-status").textContent = e.message;
    $("o-status").className = "status err";
  }
}

function symbolOf(id) {
  const a = assetById(id);
  return a ? a.symbol : id;
}

function renderOrder(o) {
  const done = ["completed", "refunded", "expired"].includes(o.status);
  $("deposit-box").hidden = o.status !== "awaiting_deposit";
  $("d-amount").textContent = `${fmt(o.depositAmount)} ${symbolOf(o.from)}`;
  $("d-address").textContent = o.depositAddress;
  const from = assetById(o.from);
  $("d-network").textContent = from && from.token
    ? `Only send ${symbolOf(o.from)} on ${o.fromNetwork}. Tokens sent on another network cannot be recovered.`
    : `Network: ${o.fromNetwork}`;
  $("d-network").className = from && from.token ? "notice" : "fine";
  const left = Math.max(0, o.expiresAt - Date.now());
  $("d-expiry").textContent = `${Math.floor(left / 60000)} min`;

  const idx = STEP_INDEX[o.status];
  for (const li of $("steps").children) {
    const i = STEP_INDEX[li.dataset.step];
    li.className = idx === undefined ? "" : i < idx || o.status === "completed" ? "done" : i === idx ? "active" : "";
  }
  const [text, cls] = STATUS_TEXT[o.status] || [o.status, ""];
  $("o-status").textContent = text;
  $("o-status").className = `status ${cls}`;

  const out = o.amountOut || o.quotedOut;
  $("o-out").textContent = `${o.amountOut ? "" : "≈ "}${fmt(out)} ${symbolOf(o.to)} (${o.toNetwork})`;
  $("o-recipient").textContent = o.recipient;
  $("o-route").textContent = o.routeName;
  $("o-id").textContent = o.id;
  $("o-payout-row").hidden = !o.payoutTxid;
  $("o-payout").textContent = o.payoutTxid || "";
  $("o-refund-row").hidden = !o.refundTxid;
  $("o-refund").textContent = o.refundTxid || "";
  if (done) clearInterval(state.poll);
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

// ---------------------------------------------------------------- boot
async function boot() {
  [state.assets, state.health, state.info] = await Promise.all([api("/api/assets"), api("/api/health"), api("/api/info")]);
  renderInfo(state.info);
  const badges = $("badges");
  const badge = (text, warn) => {
    const s = document.createElement("span");
    s.className = `badge${warn ? " warn" : ""}`;
    s.textContent = text;
    badges.append(s);
  };
  if (state.health.network !== "mainnet") badge(state.health.network, true);
  if (state.health.chains === "mock") badge("mock chains", true);
  if (state.health.dryRun) badge("dry run", true);

  fillSelects();
  $("amount").addEventListener("input", scheduleQuote);
  $("from").addEventListener("change", () => { updateLabels(); scheduleQuote(); });
  $("to").addEventListener("change", () => { updateLabels(); scheduleQuote(); });
  $("recipient").addEventListener("input", validateForm);
  $("refund").addEventListener("input", validateForm);
  $("flip").addEventListener("click", () => {
    const f = $("from").value;
    const t = $("to").value;
    if (!assetById(t).canSend) return;
    $("from").value = t;
    $("to").value = f;
    updateLabels();
    scheduleQuote();
  });
  $("create").addEventListener("click", createOrder);
  $("copy").addEventListener("click", () => navigator.clipboard.writeText($("d-address").textContent));
  $("new").addEventListener("click", () => {
    clearInterval(state.poll);
    location.hash = "";
    $("order").hidden = true;
    $("swap").hidden = false;
  });
  $("simulate").addEventListener("click", simulateDeposit);

  const m = location.hash.match(/^#order=([0-9a-f]+)\.([\w-]+)$/);
  if (m) showOrder(m[1], m[2]);
}

boot().catch((e) => {
  $("quote-error").textContent = `Failed to load: ${e.message}`;
  $("quote-error").hidden = false;
});

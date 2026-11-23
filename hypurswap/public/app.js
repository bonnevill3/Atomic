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

// ---------------------------------------------------------------- swap form
function fillSelects() {
  const from = $("from");
  const to = $("to");
  for (const a of state.assets) {
    if (a.canSend) from.add(new Option(a.symbol, a.id));
    to.add(new Option(a.symbol, a.id));
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
    $("q-rate").textContent = `1 ${from} ≈ ${fmt(b.rate, 6)} ${to}`;
    $("q-route").textContent = b.route;
    $("q-fee").textContent = `${fmt(b.serviceFee)} ${from}`;
    $("q-eta").textContent = eta(b.etaSeconds);
    $("quote").hidden = false;
    $("q-review").textContent = `Orders above $${state.health.manualReviewUsd} are checked by hand after your deposit confirms, before the swap runs. This can add some time.`;
    $("q-review").hidden = !b.manualReview;
    state.lastQuote = b;
  } catch (e) {
    if (seq !== state.quoteSeq) return;
    $("out").textContent = "—";
    $("quote").hidden = true;
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

function renderOrder(o) {
  const done = ["completed", "refunded", "expired"].includes(o.status);
  $("deposit-box").hidden = o.status !== "awaiting_deposit";
  $("d-amount").textContent = `${fmt(o.depositAmount)} ${o.from}`;
  $("d-address").textContent = o.depositAddress;
  const from = assetById(o.from);
  $("d-network").textContent = from && from.token
    ? `Only send ${o.from} on ${o.fromNetwork}. Tokens sent on another network cannot be recovered.`
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
  $("o-out").textContent = `${o.amountOut ? "" : "≈ "}${fmt(out)} ${o.to}`;
  $("o-recipient").textContent = o.recipient;
  $("o-route").textContent = o.route;
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
  [state.assets, state.health] = await Promise.all([api("/api/assets"), api("/api/health")]);
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

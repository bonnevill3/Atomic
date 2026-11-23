"use strict";

/**
 * Optional EVM wallet connection (EIP-1193 providers found via EIP-6963, with window.ethereum
 * as fallback). Used only for conveniences: filling in addresses, showing balances and sending
 * the deposit to the order's deposit address. It never asks for signatures or token approvals.
 */
const CookieWallet = (() => {
  const KEY = "cookieswap.wallet";
  const providers = new Map(); // uuid -> { info, provider }
  const listeners = new Set();
  let current = null; // { info, provider, address, chainId }

  /** Public RPCs handed to the wallet when it doesn't know a chain yet (wallet_addEthereumChain). */
  const CHAINS = {
    1: { name: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
    56: { name: "BNB Smart Chain", symbol: "BNB", rpc: "https://bsc-dataseed.bnbchain.org", explorer: "https://bscscan.com" },
    137: { name: "Polygon", symbol: "POL", rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com" },
    8453: { name: "Base", symbol: "ETH", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
    42161: { name: "Arbitrum One", symbol: "ETH", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
    43114: { name: "Avalanche C-Chain", symbol: "AVAX", rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io" },
  };

  const remember = (v) => {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch { /* storage unavailable: just don't remember */ }
  };
  const remembered = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };

  const emit = () => listeners.forEach((fn) => fn(current));
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");

  window.addEventListener("eip6963:announceProvider", (e) => {
    const d = e.detail;
    if (d && d.info && d.provider) providers.set(d.info.uuid, { info: d.info, provider: d.provider });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function list() {
    const found = [...providers.values()];
    if (!found.length && window.ethereum) {
      found.push({ info: { uuid: "injected", name: "Browser wallet", icon: null, rdns: "injected" }, provider: window.ethereum });
    }
    return found;
  }

  function bind(entry) {
    const p = entry.provider;
    if (!p.on) return;
    p.on("accountsChanged", (accs) => {
      if (!current || current.provider !== p) return;
      if (!accs || !accs.length) return disconnect();
      current.address = accs[0];
      emit();
    });
    p.on("chainChanged", (id) => {
      if (!current || current.provider !== p) return;
      current.chainId = Number(id);
      emit();
    });
  }

  async function connect(entry, silent = false) {
    const p = entry.provider;
    const accounts = await p.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    if (!accounts || !accounts.length) {
      if (silent) return null;
      throw new Error("The wallet did not share an account");
    }
    const chainId = Number(await p.request({ method: "eth_chainId" }));
    current = { info: entry.info, provider: p, address: accounts[0], chainId };
    bind(entry);
    remember(entry.info.rdns || entry.info.uuid);
    emit();
    return current;
  }

  /** Reconnect without a prompt to the wallet used last time, if it still shares an account. */
  async function restore() {
    const id = remembered();
    if (!id) return null;
    // EIP-6963 announcements are synchronous in practice, but give slow extensions a moment.
    await new Promise((r) => setTimeout(r, 150));
    const entry = list().find((e) => (e.info.rdns || e.info.uuid) === id);
    if (!entry) return null;
    try {
      return await connect(entry, true);
    } catch {
      return null;
    }
  }

  function disconnect() {
    current = null;
    remember(null);
    emit();
  }

  async function switchChain(chainId) {
    if (!current) throw new Error("Connect a wallet first");
    if (current.chainId === chainId) return;
    try {
      await current.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(chainId) }] });
    } catch (e) {
      const c = CHAINS[chainId];
      if (e && e.code === 4902 && c) {
        await current.provider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex(chainId), chainName: c.name, nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 }, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] }],
        });
      } else {
        throw e;
      }
    }
    current.chainId = chainId;
    emit();
  }

  async function nativeBalance() {
    return BigInt(await current.provider.request({ method: "eth_getBalance", params: [current.address, "latest"] }));
  }

  async function tokenBalance(token) {
    const data = `0x70a08231${pad(current.address.toLowerCase())}`; // balanceOf(address)
    const res = await current.provider.request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
    return BigInt(res === "0x" ? 0 : res);
  }

  async function gasPrice() {
    return BigInt(await current.provider.request({ method: "eth_gasPrice" }));
  }

  async function sendNative(to, value) {
    return current.provider.request({ method: "eth_sendTransaction", params: [{ from: current.address, to, value: hex(value) }] });
  }

  async function sendToken(token, to, amount) {
    const data = `0xa9059cbb${pad(to.toLowerCase())}${pad(hex(amount))}`; // transfer(address,uint256)
    return current.provider.request({ method: "eth_sendTransaction", params: [{ from: current.address, to: token, data, value: "0x0" }] });
  }

  return {
    CHAINS,
    list,
    connect,
    restore,
    disconnect,
    switchChain,
    nativeBalance,
    tokenBalance,
    gasPrice,
    sendNative,
    sendToken,
    get current() {
      return current;
    },
    onChange(fn) {
      listeners.add(fn);
    },
  };
})();

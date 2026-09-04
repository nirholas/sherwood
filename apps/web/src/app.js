import { api, STATUS_EXPLANATION, STATUS_LABEL } from "./api.js";
import {
  countdown, esc, healthTone, parseUnits, pct, relativeTime, shortAddress, statusTone, units, usd,
} from "./format.js";
import {
  CHAIN_ID, chainId, connect, currentAccount, encodeCall, ensureChain, humanError, MAX_UINT256,
  provider, readUint, send, waitForReceipt,
} from "./wallet.js";

const USDG_DECIMALS = 6;
const COLLATERAL_DECIMALS = 18;

const state = {
  account: null,
  markets: [],
  selected: null,
  position: null,
  corporateAction: null,
  oracle: null,
  tab: "supply",
  busy: false,
  message: null,
};

const el = {
  connect: document.getElementById("connect"),
  markets: document.getElementById("markets"),
  detail: document.getElementById("detail"),
  detailBody: document.getElementById("detail-body"),
  chainNotice: document.getElementById("chain-notice"),
  refreshed: document.getElementById("refreshed"),
};

// ------------------------------------------------------------------- markets

function marketRow(m) {
  const selected = state.selected?.address === m.address;
  return `
    <tr class="clickable" data-market="${esc(m.address)}" ${selected ? 'style="background:var(--bg-inset)"' : ""}>
      <td>
        <div style="font-weight:600">${esc(m.collateralSymbol ?? shortAddress(m.collateral))}</div>
        <div class="faint" style="font-size:12px">${esc(m.collateralName ?? "")}</div>
      </td>
      <td class="mono right">${m.sharePrice ? usd(m.sharePrice) : "—"}</td>
      <td class="mono right">${pct(m.lltvPercent, 0)}</td>
      <td class="mono right">${usd(Number(m.totalSupplyAssets) / 1e6, { compact: true })}</td>
      <td class="mono right">${pct(m.utilizationPercent, 1)}</td>
      <td class="mono right green">${pct(m.supplyApr)}</td>
      <td class="mono right">${pct(m.borrowApr)}</td>
      <td class="right"><span class="tag ${statusTone(m.status)}"><span class="dot"></span>${esc(STATUS_LABEL[m.status])}</span></td>
    </tr>`;
}

function renderMarkets() {
  if (state.markets.length === 0) {
    el.markets.innerHTML = `
      <div class="empty">
        <strong>No markets yet</strong>
        The factory has not created any. Anyone can create one; a market's address is derived from its
        risk parameters, so the terms are checkable before a single dollar goes in.
      </div>`;
    return;
  }
  el.markets.innerHTML = `
    <div class="table-scroll">
      <table class="data">
        <thead><tr>
          <th>Collateral</th><th class="right">Price</th><th class="right">Max LTV</th>
          <th class="right">Supplied</th><th class="right">Used</th>
          <th class="right">Supply APR</th><th class="right">Borrow APR</th><th class="right">Oracle</th>
        </tr></thead>
        <tbody>${state.markets.map(marketRow).join("")}</tbody>
      </table>
    </div>`;
  el.markets.querySelectorAll("tr[data-market]").forEach((row) => {
    row.addEventListener("click", () => selectMarket(row.dataset.market));
  });
}

// -------------------------------------------------------------------- detail

function shieldNotice(m) {
  if (m.status === 0 && m.graceUntil <= Math.floor(Date.now() / 1000)) return "";
  if (m.status !== 0) {
    return `
      <div class="notice bad">
        <span class="icon">&#9888;</span>
        <div>
          <strong>This market is shielded: ${esc(STATUS_LABEL[m.status])}.</strong>
          ${esc(STATUS_EXPLANATION[m.status])}
          <div style="margin-top:6px" class="dim">
            While this lasts: no interest accrues, nobody can be liquidated, and borrowing and
            collateral withdrawals are refused. Repaying and supplying stay open.
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="notice warn">
      <span class="icon">&#8987;</span>
      <div>
        <strong>Grace window: liquidation incentive is at ${m.currentBonusBps} of ${m.liqBonusBps} basis points.</strong>
        Trading resumed recently. The bonus ramps back to full over ${Math.round(m.graceWindowSeconds / 3600)} hours,
        finishing in ${countdown(m.graceUntil)}, so anyone who was frozen out has a real chance to cure
        before liquidation becomes profitable.
      </div>
    </div>`;
}

function corporateActionNotice(ca) {
  if (!ca || !ca.pending) return "";
  const ratio = ca.ratio ?? 1;
  return `
    <div class="notice ${ca.dilutive ? "warn" : "info"}">
      <span class="icon">&#9881;</span>
      <div>
        <strong>A corporate action is scheduled on ${esc(ca.symbol ?? "this collateral")}.</strong>
        The token's multiplier changes by ${ratio.toFixed(4)}x at
        ${esc(new Date(ca.effectiveAt * 1000).toUTCString())}.
        ${
          ca.dilutive
            ? "Because it lowers what each token is worth, it is already applied to your collateral value. Nothing about it will surprise you later."
            : "It raises what each token is worth, so it is not credited to your collateral until it takes effect."
        }
        <div class="dim" style="margin-top:6px">
          The price feed pauses for one averaging window immediately after it lands, because a moving
          average that straddles the change is a blend of two incompatible prices.
        </div>
      </div>
    </div>`;
}

function positionPanel(m, p) {
  if (!state.account) {
    return `<div class="card"><div class="empty" style="padding:24px">
      <strong>Connect a wallet</strong>to see your position in this market.</div></div>`;
  }
  if (!p) return `<div class="card"><span class="skeleton" style="width:60%"></span></div>`;

  const hf = p.healthFactor;
  const tone = healthTone(hf);
  const bar = Number.isFinite(hf) ? Math.min(100, Math.max(0, hf * 100)) : 0;
  return `
    <div class="card">
      <h3>Your position</h3>
      <div class="grid c2" style="margin:16px 0">
        <div class="stat"><span class="k">Supplied</span>
          <span class="v">${usd(Number(p.supplyAssets) / 1e6)}</span>
          <span class="sub">earning ${pct(m.supplyApr)}</span></div>
        <div class="stat"><span class="k">Borrowed</span>
          <span class="v">${usd(p.debtUsd)}</span>
          <span class="sub">paying ${pct(m.borrowApr)}</span></div>
        <div class="stat"><span class="k">Collateral</span>
          <span class="v">${units(p.collateral, COLLATERAL_DECIMALS, 4)}</span>
          <span class="sub">${usd(p.collateralValueUsd)}</span></div>
        <div class="stat"><span class="k">Borrowing power left</span>
          <span class="v">${usd(Number(p.maxBorrow) / 1e6)}</span>
          <span class="sub">at ${pct(m.lltvPercent, 0)} max LTV</span></div>
      </div>
      ${
        p.debtUsd > 0
          ? `<div style="margin-top:6px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">
                <span class="dim">Toward the liquidation limit</span>
                <span class="mono ${tone}">${Number.isFinite(hf) ? `${(hf * 100).toFixed(1)}%` : "0%"}</span>
              </div>
              <div class="bar"><span class="${tone === "green" ? "" : tone === "amber" ? "warn" : "bad"}" style="width:${bar}%"></span></div>
              ${
                p.liquidatable
                  ? `<div class="notice bad" style="margin-top:12px"><span class="icon">&#9888;</span>
                      <div><strong>This position can be liquidated right now.</strong>
                      Repay some debt or add collateral.</div></div>`
                  : ""
              }
            </div>`
          : `<p class="faint" style="font-size:13px;margin-top:4px">No debt, so nothing to liquidate.</p>`
      }
    </div>`;
}

function oraclePanel(m, o) {
  if (!o) return "";
  return `
    <div class="card">
      <h3>Oracle</h3>
      <div class="grid c2" style="margin-top:14px;gap:14px">
        <div class="stat"><span class="k">On chain (settlement)</span>
          <span class="v">${o.twapSharePrice ? usd(o.twapSharePrice) : "—"}</span>
          <span class="sub">30-minute pool average</span></div>
        <div class="stat"><span class="k">Exchange (bound)</span>
          <span class="v">${o.attestedSharePrice ? usd(o.attestedSharePrice) : "—"}</span>
          <span class="sub">attested ${relativeTime(o.quotePublishedAt)}</span></div>
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);font-size:13px" class="dim">
        The two sources sit
        <strong class="${Math.abs(o.deviationBps ?? 0) > 200 ? "amber" : "green"} mono">${
          o.deviationBps === null ? "—" : `${o.deviationBps > 0 ? "+" : ""}${o.deviationBps}bps`
        }</strong>
        apart. Sherwood settles on the on-chain price because that is what a liquidator can realise,
        and uses the exchange price only to bound it. Move either one far enough and the feed goes
        dark rather than picking a winner.
      </div>
    </div>`;
}

function actionPanel(m, p) {
  const shielded = m.status !== 0;
  const tabs = [
    ["supply", "Supply"],
    ["withdraw", "Withdraw"],
    ["collateral", "Add collateral"],
    ["borrow", "Borrow"],
    ["repay", "Repay"],
  ];
  const blocked = {
    supply: null,
    withdraw: null,
    collateral: null,
    borrow: shielded ? "Borrowing is off while the collateral has no usable price." : null,
    repay: null,
  }[state.tab];

  const hint = {
    supply: "Lend USDG into this market and earn the borrow rate, scaled by how much of it is used.",
    withdraw: "Take supplied USDG back out. Open even during a halt, subject to idle liquidity.",
    collateral: `Post ${esc(m.collateralSymbol ?? "collateral")} to borrow against.`,
    borrow: "Draw USDG against your collateral, up to the market's maximum loan-to-value.",
    repay: "Pay debt down. Always open, including through a halt.",
  }[state.tab];

  const symbol = state.tab === "collateral" ? (m.collateralSymbol ?? "collateral") : "USDG";
  const max = {
    supply: null,
    withdraw: p ? Number(p.supplyAssets) / 1e6 : null,
    collateral: null,
    borrow: p ? Number(p.maxBorrow) / 1e6 : null,
    repay: p ? p.debtUsd : null,
  }[state.tab];

  return `
    <div class="card">
      <div class="tabs" role="tablist">
        ${tabs
          .map(
            ([id, label]) =>
              `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`,
          )
          .join("")}
      </div>
      <p class="dim" style="font-size:13px;margin-bottom:14px">${hint}</p>
      ${blocked ? `<div class="notice warn"><span class="icon">&#9888;</span><div>${esc(blocked)}</div></div>` : ""}
      <label class="field">
        <span class="label">
          <span>Amount (${esc(symbol)})</span>
          ${max !== null ? `<button class="btn ghost sm" id="max-btn" type="button" style="padding:0;border:none;background:none;color:var(--accent)">Max ${max.toFixed(2)}</button>` : ""}
        </span>
        <input class="amount" id="amount" inputmode="decimal" placeholder="0.00" autocomplete="off"
          ${state.busy || blocked ? "disabled" : ""}>
      </label>
      <button class="btn primary block" id="submit" type="button" ${state.busy || blocked || !state.account ? "disabled" : ""}>
        ${state.busy ? "Waiting for the chain&hellip;" : !state.account ? "Connect a wallet" : tabs.find(([id]) => id === state.tab)[1]}
      </button>
      ${state.message ? `<div class="notice ${state.message.tone}" style="margin:14px 0 0"><span class="icon">${state.message.tone === "bad" ? "&#9888;" : "&#10003;"}</span><div>${esc(state.message.text)}</div></div>` : ""}
    </div>`;
}

function renderDetail() {
  const m = state.selected;
  if (!m) {
    el.detail.hidden = true;
    return;
  }
  el.detail.hidden = false;
  el.detailBody.innerHTML = `
    <div class="section-head" style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">${esc(m.collateralSymbol ?? shortAddress(m.collateral))} / USDG</h2>
      <span class="tag ${statusTone(m.status)}"><span class="dot"></span>${esc(STATUS_LABEL[m.status])}</span>
      <a class="faint mono" style="margin-left:auto;font-size:12px"
         href="https://robinhoodchain.blockscout.com/address/${esc(m.address)}" rel="noopener">
        ${esc(shortAddress(m.address))} &#8599;
      </a>
    </div>
    ${shieldNotice(m)}
    ${corporateActionNotice(state.corporateAction)}
    <div class="grid c2" style="align-items:start">
      <div class="grid" style="gap:16px">
        ${positionPanel(m, state.position)}
        ${oraclePanel(m, state.oracle)}
        <div class="card">
          <h3>Terms</h3>
          <table class="data" style="margin-top:8px">
            <tbody>
              <tr><td class="dim">Maximum loan-to-value</td><td class="mono right">${pct(m.lltvPercent, 0)}</td></tr>
              <tr><td class="dim">Liquidation bonus</td><td class="mono right">${(m.liqBonusBps / 100).toFixed(2)}%</td></tr>
              <tr><td class="dim">Most of a debt one liquidation may repay</td><td class="mono right">${(m.closeFactorBps / 100).toFixed(0)}%</td></tr>
              <tr><td class="dim">Grace window after a halt</td><td class="mono right">${Math.round(m.graceWindowSeconds / 3600)}h</td></tr>
              <tr><td class="dim">Idle liquidity</td><td class="mono right">${usd(Number(m.available) / 1e6)}</td></tr>
            </tbody>
          </table>
          <p class="faint" style="font-size:12px;margin-top:12px">
            These are fixed. The market has no owner and no upgrade path, so nothing here can change
            under a position that is already open.
          </p>
        </div>
      </div>
      ${actionPanel(m, state.position)}
    </div>`;

  el.detailBody.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.message = null;
      renderDetail();
    });
  });
  const submit = el.detailBody.querySelector("#submit");
  if (submit) submit.addEventListener("click", onSubmit);
  const maxBtn = el.detailBody.querySelector("#max-btn");
  if (maxBtn) {
    maxBtn.addEventListener("click", () => {
      const input = el.detailBody.querySelector("#amount");
      const value = maxBtn.textContent.replace("Max ", "").trim();
      if (input) input.value = value;
    });
  }
}

// ------------------------------------------------------------------- actions

async function ensureAllowance(token, spender, needed, decimals) {
  const allowance = await readUint(token, "allowance(address,address)", [state.account, spender]);
  if (allowance >= needed) return;
  const hash = await send(state.account, token, encodeCall("approve(address,uint256)", [spender, MAX_UINT256]));
  setMessage("info", "Approving the market to move your tokens…");
  await waitForReceipt(hash);
}

function setMessage(tone, text) {
  state.message = { tone: tone === "info" ? "info" : tone, text };
  renderDetail();
}

async function onSubmit() {
  const m = state.selected;
  const input = el.detailBody.querySelector("#amount");
  const decimals = state.tab === "collateral" ? COLLATERAL_DECIMALS : USDG_DECIMALS;
  const amount = parseUnits(input?.value, decimals);
  if (amount === null || amount === 0n) {
    setMessage("bad", "Enter an amount.");
    return;
  }

  state.busy = true;
  state.message = null;
  renderDetail();

  try {
    await ensureChain();
    let hash;
    if (state.tab === "supply") {
      await ensureAllowance(m.loanToken, m.address, amount, USDG_DECIMALS);
      hash = await send(state.account, m.address, encodeCall("supply(uint256,address)", [amount, state.account]));
    } else if (state.tab === "withdraw") {
      // Withdrawals are denominated in shares on chain, so the typed asset amount is converted here
      // using the market's own share price, then floored so a rounding wei cannot revert the call.
      const totalAssets = BigInt(m.totalSupplyAssets);
      const totalShares = BigInt(m.totalSupplyShares);
      const shares = (amount * (totalShares + 1_000_000n)) / (totalAssets + 1n);
      const owned = BigInt(state.position?.supplyShares ?? "0");
      hash = await send(
        state.account,
        m.address,
        encodeCall("withdraw(uint256,address)", [shares > owned ? owned : shares, state.account]),
      );
    } else if (state.tab === "collateral") {
      await ensureAllowance(m.collateral, m.address, amount, COLLATERAL_DECIMALS);
      hash = await send(
        state.account,
        m.address,
        encodeCall("supplyCollateral(uint256,address)", [amount, state.account]),
      );
    } else if (state.tab === "borrow") {
      hash = await send(state.account, m.address, encodeCall("borrow(uint256,address)", [amount, state.account]));
    } else if (state.tab === "repay") {
      await ensureAllowance(m.loanToken, m.address, amount, USDG_DECIMALS);
      hash = await send(
        state.account,
        m.address,
        encodeCall("repay(uint256,uint256,address)", [amount, 0n, state.account]),
      );
    }

    setMessage("info", "Submitted. Waiting for confirmation…");
    await waitForReceipt(hash);
    if (input) input.value = "";
    state.busy = false;
    setMessage("ok", "Done.");
    await refresh();
    await selectMarket(m.address);
  } catch (err) {
    state.busy = false;
    setMessage("bad", humanError(err));
  }
}

// -------------------------------------------------------------------- wiring

async function selectMarket(address) {
  const market = state.markets.find((m) => m.address.toLowerCase() === address.toLowerCase());
  if (!market) return;
  state.selected = market;
  state.position = null;
  state.oracle = null;
  state.corporateAction = null;
  renderMarkets();
  renderDetail();
  el.detail.scrollIntoView({ behavior: "smooth", block: "start" });

  const [position, oracle, corporateAction] = await Promise.all([
    state.account ? api.position(market.address, state.account).catch(() => null) : Promise.resolve(null),
    api.oracle(market.collateral).catch(() => null),
    api.corporateAction(market.collateral).catch(() => null),
  ]);
  state.position = position;
  state.oracle = oracle;
  state.corporateAction = corporateAction;
  renderDetail();
}

async function refresh() {
  try {
    state.markets = await api.markets();
    if (state.selected) {
      const updated = state.markets.find((m) => m.address === state.selected.address);
      if (updated) state.selected = updated;
    }
    el.refreshed.textContent = `updated ${new Date().toLocaleTimeString()}`;
    renderMarkets();
    renderDetail();
  } catch (err) {
    el.markets.innerHTML = `
      <div class="empty">
        <strong>Cannot reach the read API</strong>
        Start it with <code class="mono">pnpm --filter @sherwood/api start</code>, pointed at a deployed
        factory and oracle.
        <div class="faint" style="margin-top:10px">${esc(err.message)}</div>
      </div>`;
  }
}

async function renderChainNotice() {
  if (!provider()) {
    el.chainNotice.innerHTML = `
      <div class="notice info"><span class="icon">&#8505;</span>
        <div><strong>No wallet detected.</strong> You can browse every market read-only. Install a
        browser wallet to supply or borrow.</div></div>`;
    return;
  }
  const id = await chainId().catch(() => null);
  if (state.account && id !== null && id !== CHAIN_ID) {
    el.chainNotice.innerHTML = `
      <div class="notice warn"><span class="icon">&#9888;</span>
        <div><strong>Your wallet is on chain ${id}.</strong> Sherwood is on Robinhood Chain (${CHAIN_ID}).
        <button class="btn sm" id="switch-chain" type="button" style="margin-left:8px">Switch</button></div></div>`;
    document.getElementById("switch-chain")?.addEventListener("click", async () => {
      try {
        await ensureChain();
        await renderChainNotice();
      } catch (err) {
        alert(humanError(err));
      }
    });
    return;
  }
  el.chainNotice.innerHTML = "";
}

function renderConnect() {
  el.connect.textContent = state.account ? shortAddress(state.account) : "Connect wallet";
  el.connect.classList.toggle("primary", !state.account);
}

el.connect.addEventListener("click", async () => {
  if (state.account) return;
  try {
    state.account = await connect();
    await ensureChain();
    renderConnect();
    await renderChainNotice();
    if (state.selected) await selectMarket(state.selected.address);
  } catch (err) {
    alert(humanError(err));
  }
});

if (provider()) {
  provider().on?.("accountsChanged", async (accounts) => {
    state.account = accounts?.[0] ?? null;
    renderConnect();
    if (state.selected) await selectMarket(state.selected.address);
  });
  provider().on?.("chainChanged", () => window.location.reload());
}

(async function start() {
  state.account = await currentAccount().catch(() => null);
  renderConnect();
  await renderChainNotice();
  await refresh();
  setInterval(refresh, 20_000);
})();

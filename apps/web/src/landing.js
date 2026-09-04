import { api, STATUS_LABEL } from "./api.js";
import { esc, pct, statusTone, usd } from "./format.js";

const mount = document.getElementById("markets-mount");

function marketRow(m) {
  const tone = statusTone(m.status);
  const supply = Number(m.totalSupplyAssets) / 1e6;
  const borrowed = Number(m.totalBorrowAssets) / 1e6;
  return `
    <tr>
      <td>
        <div style="font-weight:600">${esc(m.collateralSymbol ?? "collateral")}</div>
        <div class="faint" style="font-size:12px">${esc(m.collateralName ?? m.collateral)}</div>
      </td>
      <td class="mono right">${m.sharePrice ? usd(m.sharePrice) : "—"}</td>
      <td class="mono right">${pct(m.lltvPercent, 0)}</td>
      <td class="mono right">${usd(supply, { compact: true })}</td>
      <td class="mono right">${usd(borrowed, { compact: true })}</td>
      <td class="mono right green">${pct(m.supplyApr)}</td>
      <td class="mono right">${pct(m.borrowApr)}</td>
      <td class="right"><span class="tag ${tone}"><span class="dot"></span>${esc(STATUS_LABEL[m.status] ?? "unknown")}</span></td>
    </tr>`;
}

async function render() {
  try {
    const markets = await api.markets();
    if (markets.length === 0) {
      mount.innerHTML = `
        <div class="empty">
          <strong>No markets have been created yet</strong>
          The contracts are deployed and the oracle is live; the first market appears here the moment
          one is created. <a href="https://github.com/nirholas/sherwood#creating-a-market">How to create one</a>.
        </div>`;
      return;
    }
    document.getElementById("s-assets").textContent = String(markets.length);
    mount.innerHTML = `
      <div class="table-scroll">
        <table class="data">
          <thead><tr>
            <th>Collateral</th><th class="right">Price</th><th class="right">Max LTV</th>
            <th class="right">Supplied</th><th class="right">Borrowed</th>
            <th class="right">Supply APR</th><th class="right">Borrow APR</th><th class="right">Oracle</th>
          </tr></thead>
          <tbody>${markets.map(marketRow).join("")}</tbody>
        </table>
      </div>`;
  } catch (err) {
    mount.innerHTML = `
      <div class="empty">
        <strong>The read API is not reachable from this page</strong>
        Markets load from <code class="mono">/api/markets</code>. Start it with
        <code class="mono">pnpm --filter @sherwood/api start</code> and point it at a deployed factory.
        <div class="faint" style="margin-top:10px">${esc(err.message)}</div>
      </div>`;
  }
}

render();
setInterval(render, 30_000);

# Sherwood web

The landing page and the working platform. **No bundler, no framework, no dependencies.**

```bash
pnpm --filter @sherwood/api start     # serves this directory and the API it reads
```

Open `http://localhost:8790`.

| File | What it is |
|---|---|
| `index.html` | Landing page. Explains the design and shows live markets |
| `app.html` | The platform: connect, supply, borrow, repay, withdraw |
| `assets/app.css` | Design tokens and every component |
| `src/format.js` | Formatting, and amount parsing that never touches a float |
| `src/api.js` | The read API, plus the status labels and what each one means for a person |
| `src/wallet.js` | EIP-1193, chain switching, ABI encoding, receipt polling, revert translation |
| `src/app.js` | The platform |
| `src/landing.js` | Live market table on the landing page |

## Why there is no build step

The app talks to six functions on one contract. A bundler, a framework and a wallet library would be
several megabytes of dependency surface, a build to keep working, and a supply chain to trust, in
exchange for convenience this page does not need.

Instead [`src/wallet.js`](src/wallet.js) carries a keccak-256 implementation and an ABI encoder for the
argument shapes actually used. Its selectors and full calldata are **checked byte for byte against
`cast`**:

```
0x674032b8 supply(uint256,address)             cast: 0x674032b8
0x4b3fd148 borrow(uint256,address)             cast: 0x4b3fd148
0xb1e8f8ef repay(uint256,uint256,address)      cast: 0xb1e8f8ef
```

## What the interface does that others do not

**It explains a shielded market rather than showing a spinner.** Each oracle status maps to a sentence
about what it means for you:

> The issuer has paused this token. Transfers revert, so collateral cannot be seized and nobody can be
> liquidated. Interest has stopped.

> The on-chain price and the exchange price have moved apart by more than this asset's band. One of
> the two is wrong and the feed will not guess which.

**It shows the grace ramp as a countdown**, so a borrower who was frozen out can see exactly how long
they have before liquidation becomes profitable for someone else.

**It warns about scheduled corporate actions**, with the ratio, the effective time, and whether the
change is already priced into their collateral.

**It shows both oracle sources side by side** with the current spread between them, because a user
whose market is about to go offline deserves to see it coming.

## States

Every state is designed: loading uses shimmer skeletons, empty states say what to do next, and errors
are actionable. `humanError` turns a revert into a sentence:

| Revert | Shown |
|---|---|
| `MarketShielded` | This market is shielded: its collateral has no usable price right now. |
| `Unhealthy` | That would push the position past its liquidation limit. |
| `InsufficientLiquidity` | The market does not have enough idle USDG for that. |
| `IsPaused` | The issuer has paused this token, so it cannot be transferred. |

The page works read-only with no wallet installed, is responsive from 320px, respects
`prefers-reduced-motion`, and every interactive element has hover, active and focus states.

Amounts are parsed with `parseUnits`, which goes from the typed string straight to `BigInt`. A float
in that path silently truncates someone's balance.

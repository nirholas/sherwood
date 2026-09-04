import type { Address, PublicClient } from "viem";
import { parseAbiItem } from "viem";

/**
 * The set of addresses that have ever borrowed or posted collateral in a market.
 *
 * There is no on-chain enumeration of positions, so the only honest way to build the set is from
 * logs. It is kept incrementally: once the historical sweep is done, each pass reads only the blocks
 * since the last one, which is what makes a keeper cheap enough to run against a rate-limited
 * public endpoint.
 */
const BORROW_EVENT = parseAbiItem(
  "event Borrow(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets, uint256 shares)",
);
const SUPPLY_COLLATERAL_EVENT = parseAbiItem(
  "event SupplyCollateral(address indexed caller, address indexed onBehalf, uint256 assets)",
);

export class BorrowerIndex {
  private readonly known = new Set<Address>();
  private cursor: bigint | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly market: Address,
    /** Public endpoints cap the range a single `eth_getLogs` may cover. */
    private readonly chunkSize = 9_000n,
    /** Block the market was created in; sweeping from zero wastes minutes on a young chain. */
    private readonly fromBlock: bigint = 0n,
  ) {}

  get size(): number {
    return this.known.size;
  }

  addresses(): Address[] {
    return [...this.known];
  }

  /** Brings the index up to the head, one bounded range at a time. */
  async sync(): Promise<{ added: number; toBlock: bigint }> {
    const head = await this.client.getBlockNumber();
    let from = this.cursor ?? this.fromBlock;
    const before = this.known.size;

    while (from <= head) {
      const to = from + this.chunkSize > head ? head : from + this.chunkSize;
      const logs = await this.client.getLogs({
        address: this.market,
        events: [BORROW_EVENT, SUPPLY_COLLATERAL_EVENT],
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const onBehalf = (log.args as { onBehalf?: Address }).onBehalf;
        if (onBehalf) this.known.add(onBehalf);
      }
      from = to + 1n;
    }

    this.cursor = head + 1n;
    return { added: this.known.size - before, toBlock: head };
  }
}

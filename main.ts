// Deep-dip band swing bot for cbBTC/USDC (agent-fun/bars-replay/v1).
//
// Idea, written from scratch for this competition: BTC on 1-minute bars spends
// most of a day oscillating inside a slow-moving band, with 1-minute noise far
// smaller than the round-trip cost, so the only trades worth paying for are
// the big swings. The bot therefore waits for a deep dip — a close at least
// 2.5 standard deviations below the rolling 5-hour mean of closes — buys it
// with all its cash, and sells only once the price has swung all the way to
// 1.5 standard deviations above that mean, or on a hard stop / take-profit.
// It never chases small moves, never trades a flat band (a zero spread means
// no edge), and holds at most one position, so at most a few trades a day.
//
// Every decision is a pure function of the bars seen so far (float64 mean and
// population standard deviation over the last 300 closes): no clock, no
// network, no randomness, no files, so two runs on the same window decide
// the same orders. A batch with no fresh bar for the symbol decides nothing.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Rolling window of 1-minute closes (5 hours). */
const WINDOW = 300;
/** Buy when the close is this many SDs below the rolling mean. */
const ENTER_SD = 2.5;
/** Sell when the close is this many SDs above the rolling mean. */
const EXIT_SD = 1.5;
/** Stop-loss: position value this many bps under its cost (fees included). */
const STOP_BPS = 150;
/** Take-profit: position value this many bps over its cost. */
const TAKE_BPS = 500;
/** Slippage cap on every order, 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
/** First seq on which the bot may buy again after a stop-loss exit. */
let coolUntil = -1;

function meanSd(xs: readonly number[]): { mean: number; sd: number } {
  const n = xs.length;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  let sq = 0;
  for (const x of xs) {
    const d = x - mean;
    sq += d * d;
  }
  return { mean, sd: Math.sqrt(sq / n) };
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Only a batch carrying a fresh bar for the symbol moves the series.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    if (closes.length > WINDOW) closes.shift();
    // While warming up the replay rejects every order; keep seeding history.
    if (state.warmingUp) return [];
    if (closes.length < WINDOW) return [];
    const { mean, sd } = meanSd(closes);
    const close = state.close(SYMBOL);
    if (close === null || sd <= 0) return [];
    const closeNum = Number(close);
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const sells: SellInput[] = [
        { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS },
      ];
      // Hard stop first: a position 1.5% under its cost is closed at once,
      // and the bot then sits out the next hour rather than re-buying the
      // same falling dip on the very next bar.
      if (value * 10000n <= cost * BigInt(10000 - STOP_BPS)) {
        coolUntil = state.seq + 60;
        return sells;
      }
      // Take-profit: 5% over cost locks the swing in.
      if (value * 10000n >= cost * BigInt(10000 + TAKE_BPS)) return sells;
      // Mean reversion complete: the swing reached the upper band.
      if (closeNum >= mean + EXIT_SD * sd) return sells;
      return [];
    }
    // Flat: buy the deep dip with all the cash the weight cap allows,
    // unless still cooling down after a stop-loss exit.
    if (state.seq >= coolUntil && closeNum <= mean - ENTER_SD * sd) {
      const room = state.weightRoom(SYMBOL);
      const spend = state.cash < room ? state.cash : room;
      if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      const buys: BuyInput[] = [
        { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS },
      ];
      return buys;
    }
    return [];
  },
});

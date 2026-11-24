// SPDX-License-Identifier: MIT
// u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122 — launch sniper that
// rides the opening pop. It watches every curve from its CreateEvent, buys
// only launches that pass a strict filter inside their first slots (real SOL
// >= 5, at least 2 early buyers, creator buy <= 2 SOL, no sells yet, price
// already up 15-40% off create), and refuses fills that jumped more than 10%
// in the 2-slot latency — buying a spike after it printed is buying the top.
// Exits are led by a wide trailing stop so winners can run; the hard stop is
// wide because early volatility is noise, not signal. Pump.fun curves mostly
// bleed to zero, so the bot never chases a run-up past 40% and never holds a
// loser hoping it comes back. Deterministic: no clock, no randomness,
// iteration only over insertion-ordered maps fed by the batch stream. Speaks
// agent-fun/replay/v2 on stdin/stdout, no SDK, no deps.
import { createInterface } from "node:readline";

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, charged per side.

// ---- Tunable strategy knobs (v2 — swept on the dev window with a local
// latency-aware replay; the positive region is wide stops + wide trail +
// strict entry, so these sit near its robust centre, not its best cell) ----
const MAX_AGE = 6; // oldest age (slots since create) at which a first buy may be decided
const MIN_REAL_SOL = 5.0; // curve must already hold this much real SOL at entry
const MAX_REAL_SOL = 100.0; // skip curves that are already huge at entry
const MAX_DEV_BUY_SOL = 2.0; // creator's own buy in the create slot, at most
const MIN_BUYERS = 2; // distinct non-creator buyers seen before entry
const MAX_BUYERS = 6; // more early wallets than this smells like a bundled cluster
const MAX_RUNUP = 0.4; // price now over create price, at most (+40%)
const MIN_RUNUP = 0.15; // and at least +15%: only buy a launch already popping
const STAKE_SOL = 0.15; // aim per coin, capped by 1% of real reserves and by cash
const MIN_BUY_SOL = 0.03; // smallest buy worth paying the tx fee for
const BUY_SLIP_BPS = 1000; // refuse a buy whose fill price jumped >10% in latency
const SELL_SLIP_BPS = 10000; // sells always go out uncapped
const TAKE_PROFIT = 3.0; // safety valve only (+300%); the trailing stop does the work
const STOP_LOSS = 0.25; // sell all once value is -25% under cost (wide: early noise)
const TRAIL_ARM = 0.1; // trailing stop arms once value is +10% over cost
const TRAIL = 0.3; // then sell on a 30% fall from the best value seen
const MAX_HOLD = 60; // slots held, then sell whatever is left
const STALE_SLOTS = 60; // sell if no trade hit the coin for this long
const MAX_EXPOSURE_SOL = 7.0; // most SOL at cost across all positions at once
// Guardrail pacing: the run must end with a round trip of >= 0.01 SOL on at
// least 20 coins. If coins bought lag the pace, filters relax one tier.
const TARGET_COINS = 30;
const PACE_SECS = 86400; // the replay window is 24h of block time
const RELAXED_MIN_REAL_SOL = 3.0;
const RELAXED_MAX_AGE = 15;

interface Tape {
  creator: string;
  created: number | null;
  vq0: number;
  vt0: number;
  devBuy: number; // SOL the creator bought in the create slot
  buyers: Set<string>;
  bought: number; // SOL bought by others
  soldByOthers: number; // SOL sold by others
  devSold: boolean;
  lastTrade: number;
  entries: number;
  lastExit: number;
  done: boolean;
}

interface Curve {
  vq: number;
  vt: number;
  rq: number; // real quote (SOL) reserves
  complete: boolean;
}

interface Held {
  opened: number;
  peak: number; // best close value (SOL) seen
}

interface Pending {
  side: string;
  mint: string;
  amount: number; // lamports (buy) or tokens (sell)
}

let hello: any = null;
let cash = 0; // lamports, from the latest account
const positions = new Map<string, { tokens: number; cost: number }>(); // mint -> {tokens, cost lamports}
const curves = new Map<string, Curve>();
const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();
const pending = new Map<string, Pending>();
const boughtCoins = new Set<string>();
const trippedCoins = new Set<string>();
let orderSeq = 0;
let firstTime: number | null = null;
let lastTime: number | null = null;
let nBuys = 0;
let nSells = 0;
let nWins = 0;
let nLosses = 0;
let feesPaid = 0;
const rejects = new Map<string, number>();

function txFee(): number {
  return Number(hello.fees.base_fee_lamports) + Number(hello.fees.priority_fee_lamports);
}

function priceOf(c: Curve): number {
  return c.vt > 0 ? c.vq / c.vt : 0;
}

function createPrice(t: Tape): number {
  return t.vt0 > 0 ? t.vq0 / t.vt0 : 0;
}

// What selling `tokens` against this curve pays, after curve fees, in SOL.
function sellValue(tokens: number, c: Curve): number {
  if (tokens <= 0 || c.vt <= 0) return 0;
  const q = (tokens * c.vq) / (c.vt + tokens) / LAMPORTS;
  return q * (1 - CURVE_FEE) - txFee() / LAMPORTS;
}

// Most this batch's buys on one mint may spend together: 1% of real reserves.
function maxBuySol(mint: string): number {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0;
  return (c.rq * hello.caps.max_order_bps_of_real_reserve) / 10000;
}

// Cash minus what pending orders will take if they fill (buy amounts + every tx fee).
function freeCashSol(): number {
  let free = cash / LAMPORTS;
  for (const p of pending.values()) {
    free -= txFee() / LAMPORTS;
    if (p.side === "buy") free -= p.amount / LAMPORTS;
  }
  return free;
}

function committedCount(): number {
  const mints = new Set<string>(positions.keys());
  for (const p of pending.values()) if (p.side === "buy") mints.add(p.mint);
  return mints.size;
}

function hasPending(mint: string, side: string): boolean {
  for (const p of pending.values()) if (p.mint === mint && p.side === side) return true;
  return false;
}

function tapeOf(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      creator: "",
      created: null,
      vq0: 0,
      vt0: 1,
      devBuy: 0,
      buyers: new Set(),
      bought: 0,
      soldByOthers: 0,
      devSold: false,
      lastTrade: -1e12,
      entries: 0,
      lastExit: -1e12,
      done: false,
    };
    tapes.set(mint, t);
  }
  return t;
}

function curveOf(mint: string): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = { vq: 0, vt: 1, rq: 0, complete: false };
    curves.set(mint, c);
  }
  return c;
}

function applyBatch(batch: any): void {
  // Fills first: pending orders resolve, positions open and close.
  for (const f of batch.fills) {
    const p = pending.get(f.client_id);
    if (p !== undefined) pending.delete(f.client_id);
    if (f.client_id.startsWith("_")) {
      // Harness close (complete / flatten / writeoff): the position is gone.
      held.delete(f.mint);
      continue;
    }
    if (f.status === "filled") {
      feesPaid += (Number(f.fee_lamports) + Number(f.tx_fee_lamports)) / LAMPORTS;
      if (f.side === "buy") {
        nBuys++;
        boughtCoins.add(f.mint);
        if (!held.has(f.mint)) held.set(f.mint, { opened: f.slot, peak: 0 });
      } else {
        nSells++;
        if (boughtCoins.has(f.mint)) trippedCoins.add(f.mint);
      }
    } else if (f.status === "rejected" && f.reason) {
      rejects.set(f.reason, (rejects.get(f.reason) ?? 0) + 1);
    } else if (f.status === "failed") {
      feesPaid += Number(f.tx_fee_lamports) / LAMPORTS;
    }
  }
  // Account after those fills.
  cash = Number(batch.account.cash_lamports);
  positions.clear();
  for (const pos of batch.account.positions) {
    const tokens = Number(pos.token_amount);
    if (tokens > 0) {
      positions.set(pos.mint, { tokens, cost: Number(pos.cost_lamports) });
    }
  }
  // Marks carry the latest reserves for held / pending mints.
  for (const m of batch.marks) {
    const c = curveOf(m.mint);
    c.vq = Number(m.virtual_quote_reserves);
    c.vt = Number(m.virtual_token_reserves);
    c.rq = Number(m.real_quote_reserves) / LAMPORTS;
  }
  // Events: creates, trades, completes — in chain order.
  for (const e of batch.events) {
    if (e.block_time !== null && e.block_time !== undefined) {
      if (firstTime === null) firstTime = e.block_time;
      if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
    }
    if (e.event === "CreateEvent") {
      const t = tapeOf(e.mint);
      t.creator = e.creator;
      t.created = e.slot;
      t.vq0 = Number(e.virtual_quote_reserves);
      t.vt0 = Number(e.virtual_token_reserves);
      const c = curveOf(e.mint);
      c.vq = Number(e.virtual_quote_reserves);
      c.vt = Number(e.virtual_token_reserves);
      c.rq = 0;
    } else if (e.event === "TradeEvent") {
      const t = tapeOf(e.mint);
      const sol = Number(e.sol_amount) / LAMPORTS;
      t.lastTrade = e.slot;
      if (e.is_buy) {
        if (e.user === t.creator && e.slot === t.created) t.devBuy += sol;
        else if (e.user !== t.creator) {
          t.buyers.add(e.user);
          t.bought += sol;
        }
      } else {
        if (e.user === t.creator) t.devSold = true;
        else t.soldByOthers += sol;
      }
      const c = curveOf(e.mint);
      c.vq = Number(e.virtual_quote_reserves);
      c.vt = Number(e.virtual_token_reserves);
      c.rq = Number(e.real_quote_reserves) / LAMPORTS;
    } else if (e.event === "CompleteEvent") {
      const c = curveOf(e.mint);
      c.complete = true;
      tapeOf(e.mint).done = true;
      held.delete(e.mint);
    }
  }
  // Drop held records whose position is gone and nothing is in flight for it.
  for (const mint of [...held.keys()]) {
    if (!positions.has(mint) && !hasPending(mint, "buy") && !hasPending(mint, "sell")) {
      held.delete(mint);
    }
  }
}

function decide(batch: any): any[] {
  const orders: any[] = [];
  const cap = hello.caps.max_orders_per_batch;
  const now = batch.slot;
  const traded = new Set<string>();
  for (const e of batch.events) if (e.event === "TradeEvent") traded.add(e.mint);

  // ---- Exits first: every open position is checked against all exit rules.
  for (const [mint, pos] of positions) {
    if (orders.length >= cap) break;
    if (hasPending(mint, "sell")) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    const h = held.get(mint) ?? { opened: now, peak: 0 };
    if (!held.has(mint)) held.set(mint, h);
    const value = sellValue(pos.tokens, c);
    const cost = pos.cost / LAMPORTS;
    if (value > h.peak) h.peak = value;
    let exit = false;
    if (cost > 0 && value >= cost * (1 + TAKE_PROFIT)) exit = true;
    if (!exit && cost > 0 && value <= cost * (1 - STOP_LOSS)) exit = true;
    if (!exit && h.peak >= cost * (1 + TRAIL_ARM) && value <= h.peak * (1 - TRAIL)) exit = true;
    // The trailing stop is armed by value, not by time: a coin that never
    // reaches it can only leave through the hard stop or the clock.
    if (!exit && now - h.opened >= MAX_HOLD) exit = true;
    const t = tapes.get(mint);
    if (!exit && t !== undefined && t.devSold) exit = true;
    if (!exit && t !== undefined && now - t.lastTrade >= STALE_SLOTS) exit = true;
    if (!exit) continue;
    if (value >= cost) nWins++;
    else nLosses++;
    orders.push({
      side: "sell",
      client_id: `o${++orderSeq}`,
      mint,
      token_amount: String(pos.tokens),
      max_slippage_bps: SELL_SLIP_BPS,
    });
    if (t !== undefined) {
      t.lastExit = now;
      t.done = true;
    }
  }

  // ---- Entries: only mints that traded in this batch can be fresh launches.
// A coin that never trades in its first six slots has no buyers to follow,
// so scanning the traded set each batch is enough and keeps the loop cheap.
  let free = freeCashSol();
  let exposure = 0;
  for (const pos of positions.values()) exposure += pos.cost / LAMPORTS;
  for (const p of pending.values()) if (p.side === "buy") exposure += p.amount / LAMPORTS;
  const relaxed =
    firstTime !== null &&
    lastTime !== null &&
    boughtCoins.size < TARGET_COINS * Math.min(1, (lastTime - firstTime) / PACE_SECS);
  const minReal = relaxed ? RELAXED_MIN_REAL_SOL : MIN_REAL_SOL;
  const maxAge = relaxed ? RELAXED_MAX_AGE : MAX_AGE;
  for (const mint of traded) {
    if (orders.length >= cap) break;
    if (committedCount() >= hello.caps.max_open_positions) break;
    if (positions.has(mint) || hasPending(mint, "buy") || hasPending(mint, "sell")) continue;
    const t = tapes.get(mint);
    const c = curves.get(mint);
    if (t === undefined || c === undefined || c.complete || t.done) continue;
    if (t.created === null) continue;
    const age = now - t.created;
    if (age > maxAge || age < 0) {
      if (age > maxAge) t.done = true;
      continue;
    }
    if (t.entries >= 1) continue;
    if (c.rq < minReal || c.rq > MAX_REAL_SOL) continue;
    if (t.devBuy > MAX_DEV_BUY_SOL) continue;
    if (t.devSold) continue;
    if (t.buyers.size < MIN_BUYERS || t.buyers.size > MAX_BUYERS) continue;
    if (t.soldByOthers > 0) continue;
    const runup = createPrice(t) > 0 ? priceOf(c) / createPrice(t) - 1 : 0;
    if (runup > MAX_RUNUP || runup < MIN_RUNUP) continue;
    const capSol = maxBuySol(mint);
    let amount = Math.min(capSol, STAKE_SOL, MAX_EXPOSURE_SOL - exposure);
    if (amount > free - txFee() / LAMPORTS) amount = free - txFee() / LAMPORTS;
    if (amount < MIN_BUY_SOL) continue;
    const lamports = Math.floor(amount * LAMPORTS);
    if (lamports <= 0) continue;
    orders.push({
      side: "buy",
      client_id: `o${++orderSeq}`,
      mint,
      quote_lamports: String(lamports),
      max_slippage_bps: BUY_SLIP_BPS,
    });
    pending.set(`o${orderSeq}`, { side: "buy", mint, amount: lamports });
    t.entries++;
    free -= amount + txFee() / LAMPORTS;
    exposure += amount;
  }
  return orders;
}

const rl = createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    hello = msg;
    cash = Number(msg.capital.lamports);
    continue;
  }
  if (msg.type === "batch") {
    applyBatch(msg);
    const orders = decide(msg);
    // Record the buys/sells just sent as pending (sells were not recorded above).
    for (const o of orders) {
      if (o.side === "sell") {
        pending.set(o.client_id, { side: "sell", mint: o.mint, amount: Number(o.token_amount) });
      }
    }
    process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
  } else if (msg.type === "done") {
    const finalCash = Number(msg.account.cash_lamports) / LAMPORTS;
    const startCash = Number(hello.capital.lamports) / LAMPORTS;
    console.error(
      `done: pnl ${(finalCash - startCash).toFixed(6)} SOL buys ${nBuys} sells ${nSells} ` +
        `wins ${nWins} losses ${nLosses} coins ${boughtCoins.size} trips ${trippedCoins.size} ` +
        `fees ${feesPaid.toFixed(6)} SOL rejects ${JSON.stringify([...rejects])}`,
    );
    break;
  }
}

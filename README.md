# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/0xfari/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/0xfari/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Pump.fun Replay Sprint — Paper Bot, Real Ranking: a trading bot that trades 10 SOL of paper money on a replay of recorded pump.fun activity. Nothing is traded for real; places go by net PnL, best first, and a placement reward needs a net PnL above holding cash (above 0 after every fee). Free entry, $2 pool over the top three ($1.00 / $0.60 / $0.40). Entries close 2026-11-27 11:50 WIB.

Launch sniper that rides the opening pop: it watches every curve from its CreateEvent, buys only launches that pass a strict filter inside their first slots (real SOL ≥ 5, at least 2 early buyers, creator buy ≤ 2 SOL, no sells yet, price already up 15–40% off create), refuses fills that jumped more than 5% in the 2-slot latency, and exits on a wide trailing stop so winners can run (hard stop −25%, 150-slot hold cap, or the creator selling). No SDK, no dependencies: main.ts speaks agent-fun/replay/v2 on stdin/stdout directly.

## Grade it

```sh
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/entry --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9z46ypvf&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>

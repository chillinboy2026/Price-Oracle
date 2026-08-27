# pump.fun agent pipeline

A memecoin trading pipeline for pump.fun: a stream of new launches passes
through nine stages, four of which are Grok agents and five of which are
plain code. The ordering is the design — cheap filters run before expensive
ones, so a fraction of a percent of the stream ever reaches the strong model.

Built from the architecture in [zostaff's write-up][post], with reference to
[zostaff/grokbot-pumpfun][ref]. This is an independent implementation, and it
differs in one substantial way: **live execution is implemented here.** The
reference deliberately leaves `LiveExecutor` as `NotImplementedError`.

[post]: https://x.com/zostaff/status/2092608485393350733
[ref]: https://github.com/zostaff/grokbot-pumpfun

> **This is research code, not a trading product, and not financial advice.**
> Most pump.fun tokens go to zero — that is the ordinary outcome, not the rare
> one. Neither wallet auditing nor an adversarial check reliably separates a
> prepared dump from organic growth; they lower the share of obviously bad
> entries. The limits in the config bound how *fast* you can lose money, not
> whether you do. Read the [honest part](#what-goes-wrong) before `mode: live`.

## Architecture

```
                     pump.fun new-launch stream
                                 │
┌────────────────────────────────▼────────────────────────────────┐
│ 1. MONITOR             WebSocket, filtered in code              │
│    ≥5 buyers · curve <40% · has metadata · >2 min old           │
└────────────────────────────────┬────────────────────────────────┘
                   drops ~94%    │
┌────────────────────────────────▼────────────────────────────────┐
│ 1.5 CREATOR MEMORY     code, from our own closed trades         │
│    a deployer who already rugged us goes no further             │
└────────────────────────────────┬────────────────────────────────┘
┌────────────────────────────────▼────────────────────────────────┐
│ 2. ANALYZER            3 REST calls in parallel                 │
│    top-5 · snipers · diversity · socials · curve health         │
│    unconditional veto: risk >7, creator ≥25%, top-5 ≥80%        │
└────────────────────────────────┬────────────────────────────────┘
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
┌────────────────┐    ┌──────────────────┐   ┌──────────────────┐
│ 3. AUDITOR     │    │ 4. NARRATIVE     │   │ 5. TIMING        │
│ grok-4-fast    │    │ grok-4-fast      │   │ grok-4-fast      │
│ coordination,  │    │ trend, virality, │   │ the market, not  │
│ wash, dump     │    │ community        │   │ the token · 15m  │
└───────┬────────┘    └────────┬─────────┘   └────────┬─────────┘
        └──────────────────────┼──────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. SCORING MATRIX      code, weights from config                │
│    audit·0.30 + narrative·0.25 + timing·0.15 + metrics·0.30     │
└────────────────────────────────┬────────────────────────────────┘
┌────────────────────────────────▼────────────────────────────────┐
│ 7. CHECKER             grok-4, adversarial                      │
│    looks only for reasons NOT to buy; error also means no       │
└────────────────────────────────┬────────────────────────────────┘
┌────────────────────────────────▼────────────────────────────────┐
│ 8. RISK GATE           code, five limits                        │
│    per-trade cap · daily loss · trades/day · open positions     │
│    exits (background task): stop · take-profit · trail · timer  │
└────────────────────────────────┬────────────────────────────────┘
┌────────────────────────────────▼────────────────────────────────┐
│ 9. EXECUTION           dry-run, or a real Solana transaction    │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
                    JSONL log: buy / skip / close
```

## Three rules the whole thing rests on

**A failed check is a rejection, never a silent pass.** A timeout, a 500,
malformed JSON, a reply that misses the schema — each returns the *pessimistic*
value for that agent. For the auditor that is every flag raised and zero
organics; for the checker it is `approve: false`. A check that could not run
must never let a trade through. This is enforced in one place
(`agents/base.py`) so it cannot drift between agents, and it covers prompt
building too, not just the HTTP call.

**Code decides, models score.** No agent returns a buy decision. Each returns
numbers that feed a weighted matrix, and a threshold in code turns the total
into an action. However confident or well-argued a model reply is, it cannot
move money by itself.

**Cheap before expensive.** Filter → memory → REST → three fast agents →
matrix → strong model. A token killed at stage 1 costs a JSON parse. Only
tokens that clear the threshold reach `grok-4`, which is units per day rather
than thousands.

## Quick start

```bash
cd pumpfun
make dev                        # venv, deps, lint, types, tests
cp config.example.yaml config.yaml
$EDITOR config.yaml             # at minimum, your Grok key

make check-config               # validate without starting anything
make run                        # dry-run: the default
```

Keys need not go in the file at all — environment variables win over it:

```bash
export PUMPBOT_GROK_API_KEY=xai-...
make run
```

Watch it work:

```bash
python scripts/dashboard.py logs/trades.jsonl --watch 5   # live state
python scripts/replay.py   logs/trades.jsonl              # period summary
python scripts/tune.py     logs/trades.jsonl              # re-score history
```

## The agents

**Auditor** (`grok-4-fast`) gets raw trades and holders — the transactions,
not aggregates. It looks for what averages hide: matching amounts seconds
apart, a wallet trading with itself, a creator splitting a position before
dumping. Told explicitly that thin data means raise the flag, not excuse the
token.

**Narrative** (`grok-4-fast`) never looks on-chain. Name, ticker, description,
links; the question is whether this spreads. Clones of yesterday's meme are
marked down, and a dimension with no evidence scores low rather than average —
missing information is not neutral information.

**Timing** (`grok-4-fast`, cached 15 min) judges the backdrop, not the token.
Its answer is identical for every token in a window, so it is cached behind a
lock: twenty launches arriving together produce one call, not twenty. A
*failed* verdict is deliberately not cached, so one bad call cannot pin a
pessimistic backdrop in place for the whole window.

**Checker** (`grok-4`) is the only agent forbidden from looking for a reason to
buy, and it runs on the stronger model because it is the last thing before
money. It sees every prior verdict and hunts for contradictions between them —
strong meme with weak organics, healthy curve with concentrated holders, a
total carried by one component. `approve: false` is a normal outcome.

## Live execution

`src/chain/` and `LiveExecutor` implement the part the reference leaves out:
bonding-curve buys and sells, signed locally and submitted by RPC or Jito
bundle.

pump.fun is a live program whose account list has changed more than once, so
the risk of a stale hardcoded layout is real and is handled directly:

- **Nothing derivable is hardcoded.** Instruction discriminators are computed
  with Anchor's own scheme (`sha256("global:buy")[:8]`); `global` and
  `__event_authority` are derived as PDAs. Being derived makes them checkable,
  and `self_check()` asserts at import that they equal the published addresses
  — a mistyped program ID fails immediately rather than on-chain.
- **The fee recipient and the creator are read from chain state**, never
  pasted. Both have changed.
- **Simulation runs before every send.** A wrong account list fails in
  simulation and costs nothing. This is the real safety net, which is why
  disabling it earns a startup warning.

Safeguards on the money path:

| guard | what it stops |
|---|---|
| `max_wallet_spend_sol` | a scoring or sizing bug producing an unbounded order — checked independently of the risk manager |
| `max_sol_cost` on every buy | unbounded slippage; enforced by the program, and the instruction builder refuses a zero bound |
| simulate-before-send | paying fees to discover a malformed transaction |
| confirmation that raises on error | a failed transaction being recorded as a filled position |
| balance-delta accounting | a position recording the *quoted* fill rather than the received one |
| sell reads the wallet balance | over-selling after a partial fill, which fails the whole transaction |

Going live takes two deliberate steps — `mode: live` in the config *and* a
flag:

```bash
python -m src.pipeline --config config.yaml --i-understand-the-risk
```

Without the flag, a live config refuses to start.

## Risk management

Five limits gate entry. Position size is proportional to score but bounded
twice: by `max_sol_per_trade`, and by 30% of what remains of the daily loss
budget — which is what makes the last trades of a losing day small. At
`daily_loss_limit_sol` the pipeline stops until the next UTC day. Profit does
not buy back headroom; the daily limit bounds gross loss.

Four exit rules run in a background task, in priority order:

| rule | fires when | why |
|---|---|---|
| `stop_loss` | price is `stop_loss_pct` below entry | bound the loss |
| `take_profit` | price is `take_profit_pct` above entry | take the win |
| `trailing_stop` | price falls `trailing_stop_pct` from peak | don't give back a run-up |
| `max_hold` | held longer than `max_hold_seconds` | a memecoin that hasn't moved in an hour won't |

Trailing only arms once the position has actually traded above entry.
Without that guard it would trail from the entry price on every losing
position and silently override the configured stop-loss. Once armed it stays
armed even below entry, where it exits sooner than the entry-based stop would.
The peak is persisted, because a restart that began measuring from the current
price would have quietly surrendered the whole run-up.

## Creator memory

Every launch is judged from a clean slate, so without memory one deployer
could rug the same wallet three times as a stranger each time — and the
auditor cannot help, since it sees one token, not an address's history.

`src/reputation.py` keeps a book of addresses built from **our own closed
trades**: not a list from the internet and not a heuristic. A close worse than
`rug_loss_pct` counts against the deployer; after `block_creator_after_rugs`
its tokens are cut at the door, before a single paid call. Separately,
`one_position_per_creator` treats two tokens from one deployer as one bet,
because they usually die together.

Clean addresses are forgotten after `forget_creators_after_days`. Addresses
that rugged are never forgotten — they are the value of the file.

## Running unattended

**State survives restart.** Open positions, daily counters and Grok spend live
in `state/pipeline.json`. Without it a restart would reset the daily loss limit
and forget open positions — the two brakes that matter most — and a crash loop
would trade without limit. Writes are atomic (temp file plus `os.replace`), so
a half-written JSON file is never a state it can be left in. Positions always
restore; daily counters restore only if the file is from today.

**Shutdown is orderly.** SIGTERM and SIGINT stop intake, let in-flight work
finish within `shutdown_grace_seconds`, save state and close connections.
Positions are *not* liquidated, and the log says plainly that no exit rule runs
while the process is down.

**Grok spend is bounded three ways**, because it fails three ways: a token
bucket caps rate, a daily budget stops a burst of launches eating a month of
credit in one evening, and a circuit breaker stops calling an endpoint that is
not answering. While the breaker is open every agent returns its pessimistic
result — so the pipeline does not buy. No signal is a reason to stand still.

**Liveness is visible.** With `ops.health_port` set, `GET /healthz` returns
JSON (200 ok, 503 degraded, so a supervisor can restart on it) and
`GET /metrics` serves Prometheus text. Two handlers on `asyncio.start_server`;
no web framework.

**Nothing grows without bound.** The JSONL log rotates by size; the monitor's
seen-mint set is evicted alongside its deque; the queue drops oldest.

**Secrets stay out of logs.** Keys are `SecretStr` — absent from `repr`, from
model dumps and from tracebacks. `--check` prints the config masked. Key
loading errors deliberately never echo the value.

**A bad config does not start.** A zero trade cap, a threshold out of range,
`live` with no wallet key, a leftover placeholder, or a *typo'd* key name — all
are startup errors with a list, not a surprise an hour into trading. A silently
ignored typo is a disabled limit.

## Logging

JSONL, one record per line: `buy`, `skip`, `close`. Every `buy` stores the
score broken into components plus all four agent replies. That is what lets
`scripts/tune.py` re-score history under different weights without calling a
single agent again.

`scripts/replay.py` summarises where the stream was lost by stage, the score
distribution, and PnL. `scripts/dashboard.py` shows current state, with
`--watch N` to self-refresh. `scripts/tune.py` sweeps thresholds and weight
sets over past trades — and prints its own central limitation, which is that
**the log cannot know how a token the threshold rejected would have turned
out.** It describes what happened; it is not a backtest, and under 30 closed
trades it is fitting noise.

## What goes wrong

The statistics are brutal. One to two percent of pump.fun tokens graduate. Of
those, most deliver multiples to early buyers and go to zero within the hour
after migration. The last buyer on the curve is almost always exit liquidity
for the creator and the snipers. That is not a failure of the system — the
bonding curve structurally rewards the first at the expense of the last.

An agent does not change that arithmetic. It filters faster and wider; it does
not turn a 1% problem into a 50% one. If the pipeline buys ten tokens a day and
one graduates, you lost on nine. Whether the winner covers the nine is decided
by position size, exit speed, and how early you entered — not by scoring.

What the agents do **not** remove:

- **MEV and frontrunning.** Bots with mempool access can see and race your
  transaction. A Jito tip improves inclusion odds; it does not confer
  exclusivity.
- **Rugs.** A token can look clean on every metric and go to zero in five
  minutes because the creator pulled liquidity.
- **Decay speed.** A memecoin that hasn't built volume in twenty minutes is
  usually dead. Cut fast; don't wait for the bounce.
- **Model cost.** Every narrative call is money. At thousands of launches a
  day, loose stream filtering makes the bill exceed the profit. That is the
  reason for the stage ordering, not elegance.
- **Program drift.** pump.fun can change its account layout. Simulation
  catches it; nothing prevents it.

## Build order

Each stage catches its own class of error, and skipping one means trading on
hope:

1. **Monitor and filter only, one week.** How many tokens pass, and are they
   any good?
2. **Add analysis and scoring, still no buying, one week.** Compare your skips
   against what the tokens actually did.
3. **Execution at minimum size** (0.01–0.05 SOL) with hard brakes. This is
   where real costs appear — slippage, fees, MEV — and none of them show up in
   paper trading.
4. **Only then scale**, gradually, on at least two weeks of real data.

## Tests

```bash
make check      # ruff + mypy + pytest, the same as CI
make test
make cov
```

260 tests, none of which touch the network (the health-endpoint tests bind
127.0.0.1). Covered: the stream filter and its boundaries, dedupe memory
bounds, the scoring matrix at its extremes and weight normalisation, all five
risk limits, position sizing near the daily budget, the day roll, all four exit
rules and their priority, every agent failure mode (bad JSON, timeout, 500,
schema mismatch, a refusing limiter, a crash while building the prompt), the
timing cache including single-flight and failure non-caching, pump.fun
instruction encoding and curve math, the live buy/sell path against a fake RPC
including simulation failure and a confirmed-but-empty fill, config validation
and secret masking, state across restart, the spend limiters, log rotation, and
an end-to-end dry run asserting that cheap stages short-circuit expensive ones.

## Layout

```
pumpfun/
├── src/
│   ├── pipeline.py       orchestrator, lifecycle, entry point
│   ├── models.py         domain models, config, validation, secrets
│   ├── monitor.py        stage 1: stream + cheap filter
│   ├── analyzer.py       stage 2: REST metrics + vetoes
│   ├── agents/           stages 3-5, 7: base mechanics + four agents
│   ├── scoring.py        stage 6: the matrix
│   ├── risk.py           stage 8: five limits, four exits
│   ├── reputation.py     stage 1.5: creator memory
│   ├── chain/            pump.fun instructions, JSON-RPC, Jito
│   ├── executor.py       stage 9: dry-run and live
│   ├── state.py          atomic state across restart
│   ├── ops.py            spend limiters, metrics, health
│   ├── alerts.py         webhook notifications
│   └── log.py            JSONL with rotation
├── tests/                pytest, offline
└── scripts/              replay, dashboard, tune
```

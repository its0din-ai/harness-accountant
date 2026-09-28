# harness-accountant

DeepSeek balance and spend accounting for the DSH Web GUI.

Two surfaces, nothing else:

1. **A card in the sidebar**, seated directly above the Settings row - the current
   billing tier (peak or off-peak, named and coloured), the balance with an eye
   toggle that masks it, and today's spend. Collapse the sidebar and the 56px rail
   has no room for labelled rows, so it keeps the tier as a slowly breathing
   coloured circle above today's spend, and moves the balance into its tooltip.
2. **A detailed panel in the Settings modal** - the same balance, with 1 day /
   7 days / 1 month breakdowns, totals, and a per-day spend bar list. Its row in
   the settings nav carries a coin stack instead of the gear the shell draws for
   every section it does not know.

## What it does not do

No coding-plan quotas, no per-provider adapters, no voucher art, no session
switching, no i18n dictionaries, no build step. Roughly 2,500 lines covering the
host half and the browser half, and four runtime files.

## How it works

```
lib/ledger.js   pure: money as integer micro-units, daily folding, pruning
lib/probe.js    the ONLY file touching a secret or the network
lib/index.js    host: poll loop, atomic ledger on disk, two loopback routes
lib/client.js   browser: sidebar card + settings panel, no bundler, no JSX
```

The host asks DeepSeek for the balance, folds each reading into a small daily
ledger under `$DSH_HOME/harness-accountant/ledger.json`, and serves the result
as JSON. The browser half only ever receives formatted numbers - it never sees
the API key, the credential reference, or the ledger path.

Spend is the **movement of the account balance between readings**. That means
it covers every session and client on the account, not just the current window.
A balance that rises is recorded as a top-up rather than netted against spend.

### Money is never a float

`/user/balance` answers with a decimal *string*. Subtracting floats would drift,
so every amount is parsed into signed integer micro-units (1 unit = 1e-6 of the
currency) and only formatted back to a string at the edge.

### Peak is decided by the clock, in the browser

DeepSeek bills peak hours at twice the off-peak rate, and publishes the schedule as
*"01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese
public holidays"*; every other hour, weekends included, is off-peak.

The host does not evaluate that schedule. It **publishes** it - `peak` in the
`/overview` payload, windows given in minutes from midnight UTC - and the browser
half owns the clock, because the tier is a pure function of the wall clock and a
round trip would be strictly worse than reading a clock the browser already has.
Nothing is polled for it and no fixed ticker is spent on it: exactly one
`setTimeout` is armed, for the instant the tier next changes, and the tier is always
recomputed from `Date.now()` rather than advanced by the timer, so a throttled,
coalesced or sleep-delayed wakeup can only delay the correction, never leave the
reading stale. A `visibilitychange` refresh covers the tab that slept through the
boundary altogether.

Only the tier's coloured circle moves - never the words beside it - and it moves
slowly: one composited opacity cycle lasting three seconds, which reads as a status
light rather than an alarm. It is dropped entirely under `prefers-reduced-motion`,
where the circle simply stays lit.

Since the schedule is in UTC and the comparison is done in UTC, the indicator is
correct in **any** timezone - the reader's own clock never enters the decision. Only
the tooltip renders in local time, where it names the boundary and, when that
boundary is not today, the weekday. That is what makes a Friday readable: the next
peak is then Monday morning.

Chinese public holidays are deliberately **not** modelled, because this plugin
carries no holiday calendar. On those days it reports peak while DeepSeek bills
off-peak. The omission is not silent: `holidays_modelled: false` travels to the
client and the tooltip says "public holidays not modelled". The schedule itself is
not configurable - it is DeepSeek's published one, a frozen constant in
`lib/index.js`.

An unusable schedule - missing, in another reference frame, a malformed window, a
weekday outside the week - degrades to off-peak with no ticker at all, which is the
stated default and costs nothing. An indicator that says nothing beats one that
guesses.

## Install

Hosted at
[github.com/its0din-ai/harness-accountant](https://github.com/its0din-ai/harness-accountant).

```sh
# 1. back up the profile wiring first - this is the rollback
cp ~/.dsh/profiles/web/package.json      ~/.dsh/profiles/web/package.json.bak
cp ~/.dsh/profiles/web/cordis.patch.yml  ~/.dsh/profiles/web/cordis.patch.yml.bak

# 2. install from GitHub
dsh plugin --profile web add \
  git+https://github.com/its0din-ai/harness-accountant.git
```

Then reload the GUI at http://127.0.0.1:3080.

To pin a revision, append a tag or commit to the URL:

```sh
dsh plugin --profile web add \
  git+https://github.com/its0din-ai/harness-accountant.git#v0.1.0
```

### The resolution requirement

A `link:` install resolves from the **realpath** of the working copy, so
`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-credentials`, and
`@deepseek-ai/cordis` must be findable there - not from the profile's
`node_modules`. This affects **local development only**; an install from
GitHub resolves them through the profile tree and needs nothing.

To develop against a working copy:

```sh
git clone https://github.com/its0din-ai/harness-accountant
cd harness-accountant

mkdir -p node_modules/@deepseek-ai
for pkg in cordis schemastery dsh-credentials; do
  ln -s ~/.dsh/profiles/web/node_modules/@deepseek-ai/"$pkg" \
        node_modules/@deepseek-ai/"$pkg"
done

dsh plugin --profile web add link:"$PWD"
```

## Configuration

The schema lives in `lib/index.js` and the defaults are written out in
`cordis.patch.yml`, so the settings page shows real, editable values.

| key | default | notes |
| --- | --- | --- |
| `enabled` | `true` | `false` stops all background probing; routes still serve the ledger, and an explicit refresh still probes |
| `poll_interval_sec` | `60` | the healthy cadence, clamped to `>= 30` regardless of what is configured. Consecutive failures stretch it: see below |
| `retain_days` | `400` | clamped to `[7, 730]` |
| `accounting_utc_offset_minutes` | `480` | the day boundary, as a fixed offset from UTC. `480` is UTC+08:00, DeepSeek's billing day. Set `0` for UTC or your own offset for a local day. It is an offset, not a timezone: it does not model daylight saving |
| `currency` | `auto` | which wallet to follow. `auto` takes the first usable one in the order the balance response lists the wallets - right for an account that reports a single currency. Set `CNY` or `USD` to pin it; read case-insensitively, and anything else means `auto` |
| `api_key_env` | `DEEPSEEK_API_KEY` | a credential *reference*, resolved per probe |
| `api_base_url` | `https://api.deepseek.com` | must be a bare `https:` origin; plain `http:` is refused |
| `max_response_bytes` | `65536` | ceiling on the bytes the probe will buffer from a response body, schema-bounded to `[1024, 1048576]`. A balance payload is a few hundred bytes, so this is pure headroom; it exists so a hostile or broken origin cannot allocate without bound |

The API key comes from `ctx.credentials` (i.e. `~/.dsh/.credentials.yaml` or the
launch environment). It is resolved fresh for every probe and never cached.

A ledger **day** is a calendar day at `accounting_utc_offset_minutes`, not at the
host's timezone, so the service and any other process bucket the same instant into
the same day. The default follows DeepSeek's billing day rather than the operator's
local one, because the bill being accounted for is DeepSeek's.

The file carries a schema `version` and the `accounting_utc_offset_minutes` in force
when it was last written, so it says for itself how its day keys were bucketed. A file
at an older version is upgraded in place on load, and `/overview` reports that as
`ledger_notice`. A file this build cannot read - a newer `version`, or a shape that
does not validate - is never guessed at and never overwritten: it is moved aside to
`ledger.json.incompatible` in the same 0700 directory with the same 0600 mode, the
plugin starts a fresh ledger, and the reason arrives in `ledger_notice`.

A ledger tracks **one currency at a time**, and the two it knows are never mixed: `CNY`
and `USD` micro-units are not comparable, so a change of currency discards the day
series rather than summing across them. Which one that is comes from the balance
response. Under the default `auto` the plugin takes the first usable wallet **in the
order the response lists them** - there is no built-in preference for either, because
an account that reports both is exactly where a guess would decide what gets recorded.
An account that reports a single currency always follows it, CNY included. Set
`currency` to `CNY` or `USD` to pin the choice instead; a pin the account stops
reporting fails the probe by name (`account reports no CNY wallet`) rather than quietly
following the other wallet, because that substitution is precisely what would throw the
history away. The plugin holds no exchange rate and never converts: a `4.58` balance is
rendered with the sign of whichever currency the response reported, and the number itself
is passed through untouched.

A failing probe does not retry forever at the same rate. The first three consecutive
failures keep the configured cadence, because a service that blinks once should be
retried normally; after that each further failure doubles the wait, up to sixteen times
the configured interval. One successful reading clears the streak and the wait goes
straight back to the base. The backing-off wait is not configurable - the three numbers
are constants in `lib/index.js`. The current streak and the pending wait are both in the
`/overview` payload (`consecutive_failures`, `next_probe_in_sec`) if you want to see the
state the loop is in.

## Development

```sh
node --test test/
```

87 tests: 22 for the ledger, 18 for the probe, 29 for the host routes and the
request fence, 17 for the client. The host tests mount the real plugin against a fake
context, a stubbed `fetch`, and a throwaway `DSH_HOME`; the client tests drive a
stub DOM and a pinned clock, because the peak tier is a function of the wall clock.

## Security

Read [THREAT.md](THREAT.md). It maps every threat this design considered, says
whether it is mitigated, and - where it is not - states the tradeoff.

The short version: the key never leaves the host process, only travels to a
verified `https:` origin with redirects refused, is redacted out of every error
path, and the two routes are fenced to same-origin loopback callers.

## Attribution

The sidebar card uses the same approach as `@linxin666/dsh-usage` (Apache-2.0):
the sidebar foot's only slot stacks *above* the Settings row and cannot host a
block, so the card is a plain `div` with its own React root seated by DOM
surgery, re-seated by a `MutationObserver`, and switched between its full and
rail forms by a second one watching the shell's collapsed marker. No code was
copied; the balance and ledger logic here is independent.

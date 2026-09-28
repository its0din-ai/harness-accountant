# harness-accountant

DeepSeek balance and spend accounting for the DSH Web GUI.

Two surfaces, nothing else:

1. **A balance card in the sidebar**, seated directly above the Settings row —
   current balance with an eye toggle that masks it, plus today's spend.
2. **A detailed panel in the Settings modal** — the same balance, with 1 day /
   7 days / 1 month breakdowns, totals, and a per-day spend bar list.

## What it does not do

No coding-plan quotas, no per-provider adapters, no voucher art, no session
switching, no i18n dictionaries, no build step. Roughly 1,380 lines of source
and four runtime files.

## How it works

```
lib/ledger.js   pure: money as integer micro-units, daily folding, pruning
lib/probe.js    the ONLY file touching a secret or the network
lib/index.js    host: poll loop, atomic ledger on disk, two loopback routes
lib/client.js   browser: sidebar card + settings panel, no bundler, no JSX
```

The host asks DeepSeek for the balance, folds each reading into a small daily
ledger under `$DSH_HOME/harness-accountant/ledger.json`, and serves the result
as JSON. The browser half only ever receives formatted numbers — it never sees
the API key, the credential reference, or the ledger path.

Spend is the **movement of the account balance between readings**. That means
it covers every session and client on the account, not just the current window.
A balance that rises is recorded as a top-up rather than netted against spend.

### Money is never a float

`/user/balance` answers with a decimal *string*. Subtracting floats would drift,
so every amount is parsed into signed integer micro-units (1 unit = 1e-6 of the
currency) and only formatted back to a string at the edge.

## Install

From a checkout at `/home/bridle/dsh/harness-accountant`:

```sh
# 1. back up the profile wiring first — this is the rollback
cp ~/.dsh/profiles/web/package.json      ~/.dsh/profiles/web/package.json.bak
cp ~/.dsh/profiles/web/cordis.patch.yml  ~/.dsh/profiles/web/cordis.patch.yml.bak

# 2. install
dsh plugin --profile web add link:/home/bridle/dsh/harness-accountant
```

Then reload the GUI at http://127.0.0.1:3080.

### The resolution requirement

A `link:` install resolves from the **realpath** of this directory, so
`@deepseek-ai/schemastery` and `@deepseek-ai/dsh-credentials` must be findable
here — not from the profile's `node_modules`. A dev shim is already in place:

```
node_modules/@deepseek-ai/{schemastery,dsh-credentials,cordis}
  -> ~/.dsh/profiles/web/node_modules/@deepseek-ai/<pkg>
```

An installed (non-`link:`) copy resolves them through the profile tree instead
and needs no shim.

## Configuration

The schema lives in `lib/index.js` and the defaults are written out in
`cordis.patch.yml`, so the settings page shows real, editable values.

| key | default | notes |
| --- | --- | --- |
| `enabled` | `true` | `false` stops all background probing; routes still serve the ledger, and an explicit refresh still probes |
| `poll_interval_sec` | `60` | clamped to `>= 30` regardless of what is configured |
| `retain_days` | `400` | clamped to `[7, 730]` |
| `api_key_env` | `DEEPSEEK_API_KEY` | a credential *reference*, resolved per probe |
| `api_base_url` | `https://api.deepseek.com` | must be a bare `https:` origin; plain `http:` is refused |

The API key comes from `ctx.credentials` (i.e. `~/.dsh/.credentials.yaml` or the
launch environment). It is resolved fresh for every probe and never cached.

## Development

```sh
node --test test/
```

51 tests: 15 for the ledger, 10 for the probe, 19 for the host routes and the
request fence. The host tests mount the real plugin against a fake context, a
stubbed `fetch`, and a throwaway `DSH_HOME`.

## Security

Read [THREAT.md](THREAT.md). It maps every threat this design considered, says
whether it is mitigated, and — where it is not — states the tradeoff.

The short version: the key never leaves the host process, only travels to a
verified `https:` origin with redirects refused, is redacted out of every error
path, and the two routes are fenced to same-origin loopback callers.

## Attribution

The sidebar card uses the same approach as `@linxin666/dsh-usage` (Apache-2.0):
the sidebar foot's only slot stacks *above* the Settings row and cannot host a
block, so the card is a plain `div` with its own React root seated by DOM
surgery and re-seated by a `MutationObserver`. No code was copied; the balance
and ledger logic here is independent.

# THREAT.md — threat model for `harness-accountant`

Read this before changing `lib/probe.js` or the request fence in `lib/index.js`.
Those two places carry the entire security surface of the plugin.

## Scope and trust model

The plugin runs **in-process inside the DSH host**, as the same OS user that
runs the agent, the GUI, and every other installed plugin. That single fact
bounds what any mitigation here can mean.

| Party | Trusted? | Notes |
| --- | --- | --- |
| The DSH host process | Yes | It hands the plugin `ctx`; it could read the credential store directly |
| Other installed plugins | **No** | Same process, same privileges — see T-18 |
| The agent itself | **No** | Same OS user — see T-17 |
| The browser at `127.0.0.1:3080` | Same-origin only | See the request fence, T-05…T-08 |
| Any other origin the browser visits | No | The primary adversary the fence targets |
| `api.deepseek.com` | Trusted for authenticity | TLS only; see T-16 |
| Anything else on the LAN / internet | No | Routes are loopback-fenced, the probe is outbound-only |

## Assets

| Asset | Where it lives | Sensitivity |
| --- | --- | --- |
| DeepSeek API key | `~/.dsh/.credentials.yaml` (or the launch env) — **never** in this plugin | Critical: full account access |
| Account balance + top-up history | `$DSH_HOME/harness-accountant/ledger.json` | Personal financial data |
| Daily spend pattern | Same ledger | Behavioural metadata, even when the UI is masked |
| The API key's *reference name* | Config `api_key_env` | Low: a name, not a secret |

---

## A. Credential handling

### T-01 — API key reaching the browser — **MITIGATED**
The client half is the surface most likely to leak, since it runs in a page
with devtools and extensions.

*Mitigation.* The key exists only as a local variable inside `probe_balance`'s
caller in `lib/index.js`. `build_overview` shapes the payload field by field
rather than spreading state, so nothing added to `state` later can leak by
accident, and neither `state` nor `probe.js` is exported to the client.
`test/host.test.js` asserts the raw response body contains no `sk-` run.

*Tradeoff if unmitigated.* Total account compromise from any browser extension
with page access.

### T-02 — API key in a log, error message, or stack — **MITIGATED**
`message_of()` in `lib/probe.js:35` returns `error instanceof Error ? error.message : 'unknown error'` — deliberately narrow, because reading `.message` off an arbitrary (possibly attacker-supplied) value would invoke a getter or `toString`. Every diagnostic string then passes through `redact_secret()`, which replaces `/sk-[A-Za-z0-9_-]{4,}/g` with `sk-***` and truncates to 300 chars. The plugin never calls `console.*` at all.

*Tradeoff if unmitigated.* A proxy's error text like
`invalid key sk-abc…` lands in the UI and in any screenshot of it.

### T-03 — Key cached in memory across probes — **MITIGATED**
The key is re-resolved through `ctx.credentials.resolve()` on every probe and is
never written to `state`. A rotation in `.credentials.yaml` takes effect on the
next poll with no restart.

*Tradeoff if unmitigated.* A rotated or revoked key stays live in memory, and a
memory dump exposes it for the process lifetime either way.

### T-04 — Key-shaped data in the `credential_source` field — **MITIGATED**
`resolve_api_key` returns `source` (a label such as `file` or `env`), and runs it
through `redact_secret` before it leaves `probe.js`.

---

## B. Network egress

### T-05 — Key sent in clear text — **MITIGATED**
`normalize_base_url` (`lib/probe.js:58`) returns `undefined` unless the parsed
URL has `protocol === 'https:'`, no username/password, and no query or fragment.
A plain-http base URL fails **before** `fetch` is called, so the key never
reaches the socket. Covered by *a plain-http base URL is refused before the key
leaves the process*.

*Tradeoff.* An operator cannot point this at a local http mock. That is the
intended direction of the trade.

### T-06 — Key re-sent to a third host via redirect — **MITIGATED**
The probe sets `redirect: 'error'`, so a 30x from the balance endpoint aborts
instead of forwarding the `Authorization` header to the redirect target.

*Tradeoff if unmitigated.* A compromised or MITM'd endpoint silently harvests
the key by redirecting to a host it controls.

### T-07 — Hostile or broken response body pushed at the UI — **MITIGATED**
`parse_balance_payload` (`lib/probe.js:122`) ignores anything that is not a plain
object, requires `currency ∈ {CNY, USD}`, and requires a `total_balance` that
matches `DECIMAL_PATTERN`. A wallet that fails either check is skipped. If no
wallet survives, the result is a fixed `no usable balance in response` string.

*Tradeoff.* An API that adds a third currency is silently ignored rather than
rendered. Failing closed is the right direction for a number the user will trust
with money decisions.

### T-08 — Error page echoing the rejected request — **MITIGATED**
On `response.ok !== true`, the probe returns `http ${status}` and **never reads
the body**. Error pages and proxy notices routinely echo the request line and
headers that were just rejected.

### T-09 — Hostile server streaming an unbounded body — **PARTIAL**
`await response.json()` buffers the whole body. Only the 15 s
`AbortSignal.timeout` bounds this; there is no byte cap.

*Why not mitigated.* A size cap needs a streaming reader and a byte counter,
which is real complexity for a check against the one endpoint the operator
configured over TLS.

*Tradeoff.* A compromised `api.deepseek.com` (or a hostile value in
`api_base_url` set by whoever can edit the profile config) can exhaust memory in
the host process. The attacker who can set `api_base_url` can already run code
in the host. Accepted.

### T-10 — Redirect to a non-https scheme — **MITIGATED** (by T-06)
Redirects abort, so a downgrade cannot happen.

---

## C. The local HTTP surface

Both routes are `kind: 'exact'`, so no path traversal or prefix shadowing is
possible. `is_same_origin_local_request` (`lib/index.js:100`) runs four checks,
each closing a distinct hole.

**One layer in front, which this package does not own.** In the maintainer's
current profile the routes additionally sit behind `dsh-web-startup-auth`'s
session gate, which answers 401 for every registered route until a session cookie
exists — including third-party RPC routes (E-013). That is defence in depth this
plugin never designed and **must not depend on**: it is another package's policy,
it can be uninstalled, and it is absent from a stock profile. The fence below is
the layer this package owns, and it is the layer that has to hold on its own.

### T-11 — Any host on the network reading the balance — **MITIGATED**
Check 1: `request.socket.remoteAddress` must be `127.0.0.1`, `::1`, or
`::ffff:127.0.0.1`. The web server is assumed to be loopback-bound; this is the
defence-in-depth layer if it is ever not.

### T-12 — DNS rebinding — **MITIGATED**
Check 2: the `Host` header's hostname must be `127.0.0.1`, `localhost`, `::1`, or
`[::1]`. This is the check that matters most, because a rebound request arrives
with a **loopback socket peer** and the attacker's domain in `Host`. Without it,
a page on `evil.example` that re-resolves its own DNS to `127.0.0.1` reads the
balance as same-origin.

*Tradeoff if unmitigated.* Silent balance disclosure to any web page the user
visits while the harness is running.

### T-13 — Cross-site `fetch` from a malicious page — **MITIGATED**
Check 3 rejects an explicit `Sec-Fetch-Site` of anything other than
`same-origin` / `none`. Check 4 requires the `x-harness-accountant: 1` header,
which is **not CORS-safelisted** — so a cross-site request must first pass a
preflight, and the server never answers a preflight and never emits
`Access-Control-Allow-Origin`. The write side effect of `POST /refresh` is
therefore unreachable cross-site, not merely unreadable.

### T-14 — Cross-origin **read** of the JSON — **MITIGATED**
`write_json` sets only `content-type`, `content-length`, `cache-control`, and
`x-content-type-options`. No `Access-Control-Allow-Origin` is ever emitted, so
the browser discards the response for any other origin.

### T-15 — Response cached by a proxy or the browser — **MITIGATED**
`cache-control: no-store` on every response, `cache: 'no-store'` on the client
fetch, plus `x-content-type-options: nosniff` so a content-type confusion cannot
turn the JSON body into an executable document.

### T-16 — A local process forging the fence — **ACCEPTED**
Any process running as the same user can open a loopback socket and set all four
headers, so the fence stops **browser-origin** attackers, not local ones. A
browser-origin attacker must also hold a session cookie where the third-party gate
is installed (see the section preamble), but that is not this package's control
and is not assumed here.

*Why not mitigated.* A local attacker who can do that can already read
`ledger.json` (same user) and `~/.dsh/.credentials.yaml` directly. Adding a
nonce or a pairing token would raise the bar for exactly the attacker who is
already past it, at the cost of new storage, a new secret to leak, and a pairing
flow — against the KISS rule.

### T-17 — No rate limit on `POST /refresh` — **ACCEPTED**
`/refresh` is unbounded beyond the fence. It is not strictly *unauthenticated* in
the maintainer's profile — a session is required in front of it (E-013) — but that
gate belongs to another package, so this model does not count it as a control.

*Why not mitigated.* Concurrent calls already collapse onto one in-flight
promise, and the balance endpoint is a free read. A rate limiter means new
per-caller state and a new failure mode (locking out the real user behind a
retry loop) for no gain against a caller who could call `/overview` instead.

---

## D. Data at rest

### T-18 — Another local user reading the ledger — **MITIGATED**
The directory is created `0700`, and the file is written `0600` via a temp file
plus `rename`. Covered by *the refresh route probes and persists a 0600 ledger*.

### T-19 — A torn or interleaved ledger write — **MITIGATED**
Writes are serialized through one non-rejecting promise chain
(`state.pending_write`), written to `<path>.tmp`, then `rename`d — so a reader
never sees a half-written file, and a failed write cannot wedge the next one.

### T-20 — Prototype pollution through the ledger file — **MITIGATED**
`deserialize_ledger` rejects anything that is not the expected shape rather than
repairing it, the `days` map is `Object.create(null)`, and every on-disk key is
re-validated against `/^\d{4}-\d{2}-\d{2}$/` — so a `__proto__` key can never
reach the map. Covered by *deserialize_ledger ignores prototype-polluting keys*.

### T-21 — Unbounded ledger growth — **MITIGATED**
`prune_ledger` clamps retention to `[7, 730]` and drops days outside the window
on every fold. A corrupt or hostile config value cannot produce an unbounded
file.

### T-22 — A jump in the system clock — **ACCEPTED** (timezone half closed by B-01)
Day keys come from a configured fixed UTC offset (`accounting_utc_offset_minutes`,
default `480`), never from the host's local zone. A timezone change on the host no
longer moves the boundary, and two processes on different hosts agree on a day.
Daylight saving is not modelled — the setting is an offset, not a zone — which is
exact for the default, since mainland China has observed no DST since 1991.

A large manual clock change can still mis-attribute a reading to the wrong day.

*Why the remaining half is not mitigated.* Detecting it needs a monotonic reference
and a policy for what to do when wall-clock and monotonic disagree — real complexity
for a cosmetic mis-attribution. The worst case is a number in the wrong bucket,
never corruption: the ledger stays schema-valid.

*Residual, named:* changing the configured offset re-buckets **future** samples
only. Days already written keep the keys they were written with, so a change leaves
a one-time seam in the series rather than silently rewriting history. Nothing reads
the offset back out of the file, because the file does not record it (see B-04).

---

## E. Data in the UI and on the wire

### T-23 — XSS through a hostile field — **MITIGATED**
The client builds every node with `react.createElement` and never uses
`innerHTML`, `dangerouslySetInnerHTML`, or `document.write`. React escapes text
children. Amounts are integers formatted on the host; date keys are regex-
validated before they are stored. Static scan for the dangerous sinks returns
nothing.

### T-24 — The mask toggle read as a security control — **NOT A CONTROL**
The eye toggle replaces digits with `*` and stores the preference in
`localStorage`. It is a **shoulder-surfing guard only**. The real balance is
still in memory, in the `localStorage`-adjacent page state, in the ledger file,
and on the wire to the browser. Anyone with devtools or a screenshot before the
toggle sees it.

*Stated explicitly so no one relies on it as an authorisation boundary.*

### T-25 — The ledger itself reveals the spend pattern — **ACCEPTED**
Masking the card does not stop `ledger.json` from recording how much was spent
on which day.

*Why not mitigated.* That ledger is the feature. Encrypting it would need a key
with nowhere safer to live than the file it protects.

### T-26 — Selection of an unexpected currency — **MITIGATED**
A currency change **wipes the series** rather than comparing CNY and USD
micro-units as if they were the same unit. A silent cross-currency subtraction
would be a correctness bug with financial consequences.

---

## F. Availability and robustness

### T-27 — The poll timer holding the host process open — **MITIGATED**
The interval calls `.unref()`, so polling never keeps the process alive.

### T-28 — Concurrent probes racing each other — **MITIGATED**
`run_probe` returns a shared `state.probe_promise`, so N callers join one
outbound request rather than firing N. This is also what lets the overview route
await the first probe instead of painting an empty card behind it.

### T-29 — A reload race leaving the plugin dead — **MITIGATED**
`mount_once` guards on `Symbol.for('harness-accountant.mounted')`. A replacement
loader entry is built before the old one is disposed, so an unguarded second
mount is refused by the loader and the plugin stays dead while its settings row
still reads "active". A refused mount is queued and replayed one microtask after
the holder releases.

### T-30 — A missing or throwing credential service killing the plugin — **MITIGATED**
`ctx.get('credentials')` returns `undefined` rather than throwing, and the
lookup is wrapped anyway. Both paths degrade to a short reason string that the
card renders, and `run_probe` never throws into the poll loop.

### T-31 — Coupling to shell DOM class names — **ACCEPTED** (not security)
`mount_foot_card` finds its seat with `[class*="footArea"]`,
`[class*="settingsArea"]`, and `[data-pane="sidebar"]`. A shell restyle that
renames those classes leaves the card unseated.

*Why accepted.* The foot's only slot stacks above the Settings row and cannot
host a block, so there is no supported seat to use. The failure mode is a
missing card, never a crash: `place()` no-ops when the seat is absent and the
settings panel uses a real slot, so it keeps working.

### T-32 — A settings save remounting the loader row — **MITIGATED**
Every config field is `.volatile()`, and the plugin listens on
`loader/volatile-update` to re-read config and restart the timer in place.

---

## G. Out of scope — platform-level, not fixable here

### T-33 — Any code in the host process reading the credential store — **OUT OF SCOPE**
`ctx.get('credentials').resolve(ref)` is available to every plugin in the
process. There is no in-process boundary to enforce.

*Consequence the operator must accept.* **Installing a plugin is equivalent to
granting it the DeepSeek API key.** The agent itself runs as the same OS user.
The credential store "cannot isolate secrets from the agent" — it is a
convenience for separation of concerns, not a security boundary. Mitigating this
needs an OS-level boundary (a separate uid, a socket-activated broker), which is
a DSH platform decision, not a plugin one.

### T-34 — A compromised DSH host or a malicious updated version of this plugin — **OUT OF SCOPE**
The response is trusted on TLS alone; there is no signature over the balance.
Anyone who can modify `lib/` can exfiltrate the key on the next poll.

*Consequence.* Review the diff before updating, and keep the plugin out of the
profile unless it is wanted.

### T-35 — Supply chain — **PARTIAL**
No build step, no bundler, no `postinstall`. Two runtime imports:
`@deepseek-ai/schemastery` (config schema) and `@deepseek-ai/dsh-credentials`
(`credentialRef`), both resolved from the harness's own anchor. The client half
requires only `react` and `react-dom/client` from the host's loader.

*Tradeoff.* Those packages are trusted transitively with the rest of DSH. A
vendored copy would remove the dependency but add a fork to maintain.

---

## How to re-verify after a change

```sh
git clone https://github.com/its0din-ai/harness-accountant
cd harness-accountant

# 1. the suite, including the fence, the 0600 ledger, and the no-secret assertions
node --test test/

# 2. no dangerous sinks, no dynamic require, no logging in the plugin
grep -rnE "eval\(|new Function|child_process|innerHTML|dangerouslySetInnerHTML|document\.write" lib/
grep -rnE "require\([^'\")]|import\([^'\")]" lib/
grep -rnE "console\.|process\.stdout|process\.stderr" lib/

# 3. the key must not be reachable from the browser half at all
grep -nE "api_key|credentialRef|DEEPSEEK|Bearer" lib/client.js
```

A change is suspect if it: adds a code path that returns `state`, adds an
`Access-Control-Allow-*` header, drops a check from
`is_same_origin_local_request`, reads a non-`ok` response body, or puts anything
key-derived into a string that reaches a log, a route payload, or the DOM.

## Change log

| Date | Change |
| --- | --- |
| 2026-09-28 | Initial model: 35 threats — 25 mitigated, 2 partial (T-09, T-35), 5 accepted (T-16, T-17, T-22, T-25, T-31), 2 out of scope (T-33, T-34), 1 explicit non-control (T-24) |
| 2026-09-28 | E-013: recorded that in the maintainer's profile every registered route additionally sits behind `dsh-web-startup-auth`'s session gate. The fence is therefore defence in depth rather than the first gate — and the model explicitly does **not** count the third-party session as a control, because another package can be uninstalled. Section C gained a preamble; T-16 and T-17 reworded to match. |
| 2026-09-28 | E-016 (B-01): day keys now come from a configured fixed UTC offset instead of the host's local zone, so the timezone half of **T-22** is closed and the remainder is narrowed to a manual clock jump. T-22 reworded; its residual (an offset change re-buckets future samples only, and the file does not record the offset) is named rather than implied. |

# RunLog external uptime

A separate GitHub-hosted runner checks public RunLog health, homepage and published benchmark evidence. A five-minute operations-host timer dispatches the production workflow when no recent production run exists; native GitHub scheduling remains a best-effort secondary trigger. Each check retries once with a 10-second timeout. Two failed observations open an incident; one healthy observation recovers it. This reads public endpoints only and does not call models, change accounts, or touch application databases.

A separate Cloudflare Worker stores monitoring state in SQLite Durable Objects. Its five-minute watchdog alerts after 30 minutes without a new signed GitHub observation, including when the reporter never starts. Telegram sends happen on transitions only. Failed notifications remain in a persisted outbox and retry with capped backoff. Authenticated responses include bounded Telegram message-ID receipts; delivery acknowledgment does not prove the owner read a message.

## Deploy (operator only)

1. Export **only the contents of this directory**, including `.github`, as the root of the new public `runlog-cc/uptime` repository. Do not publish monorepo history or operator files. Use `main` as its default branch and enable Actions. The public repository avoids private Actions minute consumption.
2. Run `node --test tests/*.test.mjs` under Node 22. The platform CLI regression intentionally skips outside the monorepo. Run `wrangler deploy --dry-run` with the existing operator Wrangler installation, then `wrangler deploy --config wrangler.toml`. This provisions only `runlog-uptime` and its isolated SQLite Durable Objects. No application bindings are present.
3. Set Worker secrets `MONITOR_SECRET` (random, at least 32 characters), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` using the operator's existing approved route. Supply values over stdin; do not place them in command arguments, logs, source, or `.dev.vars` committed files. The lead's prepared owner-only JSON lives outside this repository. Never poll `getUpdates` on the existing bot.
4. Set repository Actions secrets with those same three values and `MONITOR_URL=https://runlog-uptime.fxgarrett.workers.dev`. Do not expose these to PR workflows. The standalone workflow runs only on the default `main` branch via schedule/manual dispatch and has read-only repository permission.
5. Manually dispatch `production`, then the drills below. Retain signed-report safe receipts from Actions logs and confirm the owner actually receives each alert. Confirm an actual operations timer invocation produces a successful `production · server-timer` run, and observe another timer cycle plus Worker cron execution. A manually started service is not automatic-timer proof. Native `event=schedule` evidence must be reported separately; cron activation can take time. The first cron arms the never-started-reporter watchdog.

The reporter needs `MONITOR_STATE_FILE` pointing to a writable persistent JSON file. The workflow restores/saves it with Actions cache even when probes fail. It contains only fallback incident state, not credentials. Direct operator invocation uses the same environment secrets and `node reporter.mjs production`.

## Automatic trigger on the operations host

GitHub's native cron emitted no run objects despite valid eligibility/configuration and a controlled schedule re-registration. The fallback trigger uses the existing operations host's `/usr/bin/gh` login; no GitHub credential is copied to Cloudflare or this repository. The actual probes and signed heartbeat still originate on GitHub. The host cannot mark monitoring healthy merely by dispatching a job.

Create `~/.local/state/runlog-uptime-dispatch` with mode 0700. Substitute the trusted standalone checkout path for `@UPTIME_CHECKOUT@` in `ops/runlog-uptime-dispatch.service`, install that and the timer template under `~/.config/systemd/user/`, reload the user manager and enable/start **the timer**. The existing user manager must have lingering enabled for logout/reboot persistence. Validate the unit's sandbox on the real host before accepting it.

The dispatcher holds a file lock through GET and dispatch. It ignores drills and non-main runs, skips a production observation younger than four minutes or an active job younger than ten minutes, and dispatches only fixed `runlog-cc/uptime`, `uptime.yml`, `main`, `mode=production`, `origin=server-timer`. API/authentication/dispatch failures produce a failed service with generic secret-free logs. Keep its existing GitHub login valid. A host, credential or GitHub outage stops observations; the independent Cloudflare watchdog warns after 30 minutes. This is not a five-minute SLA or proof GitHub's native cron was repaired.

Validate with `python3 -m unittest discover -s ops -p 'test_*.py'`, then retain timer calendar/last-trigger/service-journal evidence alongside the resulting GitHub run and monitor acknowledgement. Observe at least two real timer cycles. The workflow run title identifies production mode and origin, allowing deduplication if native scheduling or an operator also runs it.

## Safe live drills

Dispatch modes in order and inspect each job's output/Telegram delivery:

- `drill-fail`: performs two actual failing HTTP observations against a fixed nonexistent public control path. Sends one **[DRILL] public service DOWN** alert.
- `drill-recover`: normal public probes; sends one **[DRILL] public service RECOVERED** alert. Repeat it to confirm silence.
- `drill-stall`: authenticates a drill-only heartbeat-expiry request and sends **[DRILL] external monitor STALLED**. No production timestamps or state can be overridden.
- `drill-recover`: sends **[DRILL] external monitor RECOVERED**. Production stays in its own object throughout.

Dispatch `drill-transport-fail` to verify the independent GitHub fallback: it performs two observations and forces only its drill report transport to the reserved `https://monitor-unavailable.invalid` host. Expect one **[DRILL] monitor transport DOWN** alert. Repeat to verify silence, then dispatch `drill-recover` using the same restored state cache: expect one transport recovery alert. This is an operator-triggered message test; no application outage or configuration change is needed. Tests cover the same fallback state transitions and notification failures without network traffic.

Completed drills do not arm a later automatic heartbeat alarm. Scheduled drill ticks retry already queued notifications only; heartbeat-expiry tests require the explicit drill-stall mode.

## Limits and maintenance

GitHub schedules can run late or be dropped; this is bounded operational monitoring, not a five-minute SLA. Public scheduled workflows disable after 60 days without repository activity: the independent Worker watchdog alerts when that happens. An operator must restore the schedule. Cloudflare cron and GitHub must not both fail silently; simultaneous outages of both providers, Telegram, or the owner's device can prevent delivery. Keep platform billing/account alerts enabled separately.

The direct GitHub fallback alerts after two unacknowledged monitor observations (including pending monitor notification delivery). It deduplicates using Actions cache. Cache loss/eviction or cancellation can cause an extra alert; cache outages do not prevent probes. Recovery is acknowledged only after monitor delivery succeeds. Cloudflare and fallback alerts describe different failures and may both arrive. Telegram acceptance followed by a process crash before state persistence can rarely duplicate a delivery. Outbox storage is bounded to the newest 32 transition events during prolonged delivery failure; receipts retain the latest eight deliveries. No periodic success messages are sent.

Health requires HTTP 200, `ok:true` and a 40-character lowercase release SHA. Homepage requires the public RunLog title and links to all four tools. Feed requires its public v3 schema, a run identifier, graded results and at least one graded model. Static benchmark data is not assumed stale merely because an evaluation campaign ended. Response bodies, report sizes, requests and notification retries are bounded. Report signatures authenticate exact raw bytes plus a five-minute timestamp window; replayed or older observations cannot refresh the heartbeat.

No new paid service/account is required by this implementation. Existing Workers plan and GitHub account quotas still apply. Keep the public repository free of secrets and unrelated product source. Rotate the shared signing secret in both deployments together. Test the drills after changing the workflow, owner route, or monitoring Worker.

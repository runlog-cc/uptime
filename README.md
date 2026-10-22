# RunLog Uptime

An inspectable example of operating a deployed application: semantic HTTP probes,
signed observations, persisted incidents and recovery alerts. Part of the
[free RunLog toolkit](https://runlog.cc).

[Offline verification workflow and runs](https://github.com/runlog-cc/uptime/actions/workflows/verify.yml)

## Review it safely

From a source checkout with Node.js 22+ and Python 3.12:

```sh
git clone https://github.com/runlog-cc/uptime.git
cd uptime
npm test
python3 -m unittest discover -s ops -p 'test_*.py'
```

The tests use controlled fetch, storage, clocks and notification fixtures. They
make no model calls, send no Telegram messages and need no secrets. One
monorepo-only companion-CLI test is intentionally skipped in the standalone
export; the monitoring tests run here. Do not run `reporter.mjs production`,
dispatch the production workflow or follow deployment/drill instructions just
to try the project.

## What to inspect

| Engineering decision | Implementation and evidence |
| --- | --- |
| An HTTP 200 page is not necessarily a healthy service | [Semantic probes](probes.mjs), [probe regressions](tests/probes.test.mjs) |
| Incidents/recovery should survive restarts and avoid repeated alerts | [State machine](monitor.mjs), [outbox and recovery tests](tests/monitor.test.mjs) |
| Monitoring must detect when its own reporter stops | [Worker/watchdog](worker.mjs), [external reporter](reporter.mjs) |
| A fallback trigger cannot claim health merely by dispatching | [Bounded dispatcher](ops/dispatcher.py), [dispatcher tests](ops/test_dispatcher.py) |

I use AI during implementation and review, and verify state transitions and
failure behavior with controlled tests. This repository shows operational
choices and their limits; it is not a hosted monitoring product or an SLA.

## Architecture and limits

The existing RunLog deployment uses:

1. An operations-host timer to dispatch external GitHub observations when no
   recent production run exists. Native GitHub cron is a best-effort secondary
   trigger.
2. GitHub-hosted HTTP probes of public health, homepage and benchmark evidence.
   Signed observations go to a separate Cloudflare Worker.
3. SQLite Durable Objects for incident/outbox state and a watchdog that warns
   when observations stop. Production and drills use separate state.
4. Transition-only Telegram notifications and a bounded direct GitHub fallback
   for unavailable monitor delivery.

Two failed observations open an incident; a healthy observation recovers it.
The watchdog warns after 30 minutes without a fresh observation. Delivery receipts
prove provider acceptance, not that a person read an alert. Simultaneous provider
or notification failures, cache loss and crash timing remain operational risks.
A five-minute trigger does not establish a five-minute availability guarantee.

The public tools are free to use. Running your own infrastructure may incur
provider charges. No account, subscription or paid monitoring service is sold
by this repository. [MIT License](LICENSE).

## Operator material

[OPERATIONS.md](OPERATIONS.md) preserves the current deployment, safe-drill,
secret-handling and maintenance instructions. It is intentionally separate from
the offline reviewer path. This documentation update does not deploy the Worker,
change its production schedule or send an alert.

## Author

Built and maintained by **Francisco Garrett**.

[About the developer](https://runlog.cc/about) · [Discuss a role or project](mailto:hello@runlog.cc?subject=Role%20or%20project%20discussion)

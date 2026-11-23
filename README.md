# freight-appointment-agent

An email agent that books freight dock appointments, running live: real tool calls, a trace for every email thread, a go-live gate in CI and a staged rollout.

Lanternfly Logistics is a fictional freight brokerage. Its loads, 15 facilities (Central, Eastern and Mountain time, dock hours, holidays, notice rules, booking channels, booked slots) and the facilities' answers are constructed data in `seed/world.json` and a facility simulator in `src/store.ts`.

## What the agent does

A shipper or carrier emails the appointments desk ("PO-40111 is running 3 hours late, can you move the 7:00?"). The agent:

1. finds the load, matching the PO together with the facility because one PO can belong to several loads;
2. decides whether it is its job: hazmat, address changes, complaints, rate questions and date conflicts go to a person;
3. works out the earliest feasible slot: the carrier's ETA or the pickup time plus transit, converted to the facility's time zone, inside the customer window, after the facility's notice period, around holidays and booked slots;
4. requests it through the facility's own channel (email, portal or phone), retries a failed portal once and then falls back to email, and handles counter-offers, questions and "PO not found";
5. notifies the carrier and the account executive when it should, and writes the reply email.

## How it is built

- **Agent** (`src/agent.ts`): Claude (`claude-opus-5-5`, server-side fallback on) in a tool loop of at most 8 steps.
- **Tools** (`src/tools.ts`): find_load, get_facility, estimate_arrival, get_open_slots, request_appointment, record_existing_appointment, record_fcfs, notify, hand_off. Inputs are validated; facilities refuse the wrong channel, a closed or booked slot, and anything inside their notice period.
- **Live store** (`src/d1store.ts`): Cloudflare D1. Appointments the agent books are written to the TMS document, and notices and hand-offs to an events table.
- **Traces** (`/trace/<thread id>`): every model call (tokens, cache hits, cost, latency, which model served it) and every tool call (input, output or error).
- **Eval endpoint** (`POST /eval`): runs one go-live case (an email thread) through the same loop on a private copy of the data and reports what the agent did, read from its tool calls rather than from what it says.
- **Gate** (`gate/`): 25 email threads graded by [golive-gate](https://github.com/pg2342-hub/golive-gate) with six error codes. A wrong appointment written (including a duplicate or the wrong load) and a missed hand-off are critical. Go-live needs 24 of 25 on all three runs, 14 of 15 in-scope threads, every judgment and out-of-scope thread, and no critical failures.

## Run it locally

```
npm install
npm run db:init && npm run seed
printf 'EVAL_TOKEN=local-dev-token\nMODEL_MODE=scripted\n' > .dev.vars   # or MODEL_MODE=claude plus ANTHROPIC_API_KEY
npm run dev
pip install golive-gate
cd gate && EVAL_TOKEN=local-dev-token golive run golive.yml
npm test
```

`MODEL_MODE=scripted` swaps Claude for a scripted stand-in that reads each case's structured facts. It checks the tools, the facility simulator, the eval endpoint and the gate end to end without an API key; it says nothing about how well Claude handles the emails.

## Status

- [x] Agent, tools, facility simulator, D1 store, traces, eval endpoint; gate passes locally with the scripted stand-in
- [ ] Deployed on Cloudflare with inbound email, the gate run against Claude, rate limit and spend cap live
- [ ] Versions with a staged rollout (10% / 50% / 100%) and the gate in CI on every pull request
- [ ] Demo page and write-up

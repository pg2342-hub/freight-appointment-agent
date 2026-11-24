# Product

## What it is

An email agent that books freight dock appointments for Lanternfly Logistics, a fictional freight brokerage. Shippers and carriers email appointments@pranavgudise.dev; Claude finds the load, works out the earliest feasible dock slot, books it through the facility's own channel or hands the thread to a person, and replies. It runs live on Cloudflare with a go-live gate in CI and a staged rollout.

## Surfaces

- **Desk console** (`/desk/`): the operations view a brokerage's appointments team would keep open. What the agent handled, what it handed to a person and why, what is waiting on a facility, dock calendars, spend against the daily cap, and the release history. Mode: Operate.
- **Case study** (`/`): the demo page linked from pranavgudise.dev. Proof that it is live, the gate, the rollout, how it works. It follows the portfolio's demo-page standard and keeps the warm-paper kit.

## People

- The appointments desk team (the console's real user): coordinators and account executives who review hand-offs and check what the agent did.
- Visitors from the portfolio, often hiring managers for forward-deployed, solutions and AI operations roles, on a laptop, for a few minutes. They must see the agent's real work fast.

## Truth rules

- Every number comes from the build's own output: recorded gate runs (`gate/results/*.json`), the live D1 tables, or `/api/releases`. Nothing is invented.
- Loads, facilities and senders are constructed data; say so.
- A visitor sees the recorded threads and their own threads only, never another visitor's email.
- The console is read-only for visitors.
- No em or en dashes in visible text. Public tools and vendors may be named; no clients or employers.

## Direction

Pinned by the owner: Speakeasy's agent dashboard as the base (left navigation, a workspace switcher, a strip of large metric cells, paired ranked panels, light and dark themes), with Factory's dense session list for the thread list and a single sharp accent used only for state that needs attention. No gradient banner and no chat assistant. Original work in that genre, not a copy of either product.

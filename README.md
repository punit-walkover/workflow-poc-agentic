# Workflows POC: agentic

Ticket0 workflows built on a canvas and run by AI agents. A **supervisor** agent reads every customer message and hands it to
**one agent per workflow**, which moves through every block of the canvas with tools. A pure **step engine** on the server
checks each move, so the agents can't skip steps, take a wrong branch, run an action twice or bypass an approval.
The plan is `docs/agent-workflows-full-plan.html`.

```
workflow-poc-agentic/
  server/   NestJS 12 + Mastra 1.75 + pg     → http://localhost:4011
  web/      Next.js 16 + Tailwind 4 + React Flow + TipTap 3   → http://localhost:4010
```

It started as a copy of `../workflows-poc` (the DBOS + GTWY baseline, still kept there); ports and the database differ, so both run side by side.

## How it works

- **Canvas** (`web/src/components/canvas`): groups of blocks joined by arrows: AI steps (with `@action` chips and "Save response"),
  text bubbles, inputs (text, email, number, phone), conditions (AI or rules) and loops with a repeat limit. Publishing freezes a
  version and builds its read-only **workflow map** (`server/src/engine/map.ts`).
- **Inbox** (`server/src/agents/inbox.ts`): customer messages, approval decisions, run panel controls and timers become
  `ticket_event` rows, handled one at a time per chat. A reply the customer has already moved past is dropped and the next turn
  answers everything; a 30 s sweeper sends reminders, closes silent chats and escalates approval timeouts.
- **Supervisor** (`server/src/agents/agents.ts`): delegates to the active workflow (answer / not an answer / off-topic), starts or
  switches a workflow, hands off to a person, or replies itself.
- **Workflow agent**: gets the map, the current step card, progress and the current step's action args, and moves every block
  with the `wf_*` tools (`server/src/agents/wf-tools.ts`): `wf_save_input`, `wf_choose_case`, `wf_complete_step`, `call_action`,
  `wf_handoff`, `wf_yield`. Each tool checks the move with the engine and returns the next step card, or a reason and a fix.
  Rules conditions are picked by the agent and checked against the rules; text bubbles must appear word for word in its reply.
- **Step engine** (`server/src/engine/engine.ts`): pure rules, no DB or AI: next block, input formats and retries, rules,
  loops (`maxVisits`, "ask again"), save response (`$` = whole response), approvals and idempotency.
- **Approvals**: actions marked **Needs approval** wait for a teammate (Approvals page or in the chat); the inbox runs the approved
  action, then the workflow agent tells the customer. Run panel controls: pause, resume, cancel, retry a failed step.
- **Cost**: every model call is a row in `llm_usage`, priced from `server/src/agents/prices.ts`. The run panel shows the
  conversation's total and the cost of each call.

## Run it

```bash
cd workflow-poc-agentic/server && cp .env.example .env   # then fill in the values
npm install && npm run db:setup && npm run dev            # API on 4011
cd ../web && cp .env.example .env.local && npm install && npm run dev   # UI on 4010
cd ../server && npm test                                  # engine + map unit tests
```

Or use the `workflow-poc-agentic-server` / `workflow-poc-agentic-web` entries in `.claude/launch.json`.

### Calling the tools by hand (`DEV_ENDPOINTS=1`)

```bash
curl -X POST localhost:4011/dev/agent-runs -H 'content-type: application/json' -d '{"workflow_id":"<published workflow>"}'
curl localhost:4011/dev/agent-runs/<run_id>
curl -X POST localhost:4011/dev/agent-runs/<run_id>/tools/wf_save_input -H 'content-type: application/json' -d '{"input_id":"<id>","value":"ORD-5006"}'
curl -X POST localhost:4011/dev/agent-runs/<run_id>/approval -H 'content-type: application/json' -d '{"approved":true}'
curl localhost:4011/dev/workflows/<workflow_id>/map
curl -X POST localhost:4011/dev/llm/probe -H 'content-type: application/json' -d '{"message":"hi"}'   # needs LLM_* set
```

## Tools through viaSocket

Tools are created only in viaSocket's own builder (`web/src/components/viasocket-panel.tsx`):
- The embed loads with a builder token (`GET /integrations/builder-token`); **Actions → New tool** opens straight on "Add New Tool",
  and the pencil on a tool reopens its flow.
- App connections are made inside the builder; this app keeps none of its own.
- viaSocket posts a window message when a tool is published, updated, paused or deleted. Its `openaiToolJson` becomes an action
  (`source = viasocket_flow`, `POST /actions/from-flow`). New tools start with **Needs approval** on.
- At runtime the agent's args are POSTed as JSON to the tool's run URL (`https://flow.sokt.io/func/<id>`), once per step visit.

## POC shortcuts

- Single tenant (no `org_id`); playground conversations stand in for tickets; no auth.
- Timeline events live in Postgres `run_event`; files are stored on local disk.
- Replies are sent automatically (no draft mode).
- Models are called directly (`LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY`); `openai-compatible` with `LLM_BASE_URL` is ready for a
  GTWY pass-through endpoint later.

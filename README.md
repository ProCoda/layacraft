# jevcraft

Autonomous, adaptive Minecraft bot. Give it a goal in plain language ("Find diamond", "build a cute house") or talk to it
in the game chat. **Jev** (TypeSafe's System One model) makes every fast decision; an **LLM** plans, designs structures,
answers players and recovers when stuck. Game rules come from game data, world knowledge is learned. Built on mineflayer.

```
            goal / player chat
                    │
    ┌───────────────▼───────────────┐  rare: plan, blueprint design, chat, recovery, world facts
    │  STRATEGIST (LLM, System 2)   │  milestones with machine-checkable completion
    └───────────────┬───────────────┘
                    │ current milestone
    ┌───────────────▼───────────────┐  every step, ~5 ms, from game data + what the bot has seen:
    │  ACQUISITION PLANNER (code)   │  cheapest chain to obtain anything (craft / smelt / mine with the right
    │                               │  tool / kill), materials for structures, what is doable right now
    └───────────────┬───────────────┘
    ┌───────────────▼───────────────┐  one request per step (fan-out): skill + target per skill + danger score
    │  TACTICIAN (Jev, System 1)    │  only executable options, each annotated with evidence
    └───────────────┬───────────────┘
    ┌───────────────▼───────────────┐  MINE CRAFT SMELT EXPLORE DIG_DOWN STRIP_MINE HUNT GOTO SHELTER SURFACE BUILD
    │  SKILLS (code)                │  deterministic, abortable, watchdog, opportunity lookout
    └───────────────┬───────────────┘
    ┌───────────────▼───────────────┐  lava, drowning, fight/flee, urgent eating; preempts any skill
    │  REFLEXES (code, 4 Hz)        │
    └───────────────────────────────┘
```

## Principles

- **Code verifies, models choose.** Milestones complete when a predicate is true (`have diamond 1`, `at_or_below_y -58`,
  `near_block`, `built house`), never because a model says so.
- **Nothing game-specific is hard-coded.** Recipes, block drops, harvest tools, food and mob categories come from the
  game registry. Where blocks generate and what smelting produces are asked once from the LLM, validated against the
  registry, cached, then corrected by observation.
- **It learns from its own experience** (`memory/`): the heights and biomes where each block was actually seen, the real
  yield of every block it breaks (loot tables are often wrong), how often each creature appears, each skill's success
  rate, remembered places per world (hashed seed), death causes, and strategist lessons.
- **Jev only picks among valid options.** The action space is rebuilt every step. Jev never sees coordinates or does
  arithmetic; counts, recipe trees and depths are computed in code. EXPLORE options describe each heading (biomes,
  water, trees, animals, open caves, explored or not). A Jev *score* question rates danger; the code enforces a safety
  action when it is high.
- **Escalation, not loops.** Low confidence asks the LLM in the background; `STUCK`, repeated failures or no progress ask
  it in the foreground; a step no skill can act on is reported in chat and skipped.
- **Fair perception by default**: only blocks touching open space and close or in line of sight. `--xray` reads chunks.
- **Creative mode is detected**: items are spawned on demand, no gathering, no survival concerns.

## Run

```bash
npm install
./scripts/setup-server.sh      # optional local Paper 1.21.4 test server (accepts the Minecraft EULA)
npm run server                 # in another terminal
npm start -- --goal "Find diamond"
```

Connect a 1.21.4 client to `localhost` to watch. In the game chat, any sentence is an instruction the bot answers and
acts on ("go get your stuff back", "build me a tower instead"). Commands: `!goal <text>`, `!stop`, `!status`, `!plan`,
`!usage`.

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | Jev key |
| `TYPESAFE_MODEL` | `jev-latest` | Jev model |
| `LLM_PROVIDER` | auto | `claude-cli` (local `claude` CLI, uses your Claude subscription), `anthropic` (`ANTHROPIC_API_KEY`), `openai` (any OpenAI-compatible endpoint: `LLM_API_KEY`, `LLM_BASE_URL`) |
| `LLM_MODEL` | provider default | e.g. `sonnet`, `claude-sonnet-5` |
| `--host --port --user --version` | `localhost 25565 Jev auto` | server |
| `--xray` / `PERCEPTION=xray` | off | omniscient block perception |
| `JEV_ADVISE_BELOW` | `0.45` | Jev confidence below which background advice is requested |

Helpers: `npx tsx scripts/rcon.ts "time set day"` (local server RCON), `npx tsx scripts/say.ts "!goal ..."`,
`npx tsx scripts/trial.ts <seed> [minutes] [goal]` (unattended run on a fresh world, prints a summary).

Cost: Jev is billed per input token ($0.042/M; a decision is a few thousand tokens). The `claude-cli` provider runs on
your Claude subscription. `!usage` and the shutdown log print actual totals.

## Layout

| Path | Job |
| --- | --- |
| `src/brain/agent.ts` | Orchestrator loop: escalation, watchdog, opportunity lookout, deaths, hunger, chat instructions |
| `src/brain/tactician.ts` | Needs from the planner, dynamic action space, the Jev request (incl. danger score) |
| `src/brain/strategist.ts` | LLM prompts: plan, recovery, world facts, blueprint design, chat instructions |
| `src/brain/plan.ts`, `reflex.ts`, `jev.ts`, `llm.ts` | Predicates, survival reflexes, model clients |
| `src/world/acquire.ts` | Generic acquisition planner (reusable tools/stations counted once) |
| `src/world/knowledge.ts` | Learned world knowledge shared across worlds |
| `src/world/blueprint.ts` | Structure expansion, site choice, progress and bill of materials |
| `src/world/directions.ts`, `perception.ts`, `memory.ts`, `crafting.ts`, `creative.ts` | Senses, per-world memory, craft execution plans, creative mode |
| `src/skills/` | Skill library; `craft-window.ts` = acknowledged crafting clicks |

Two mineflayer issues on 1.21 are worked around: a single global window `stateId` (tracked per window in
`protocol-fixes.ts`) and fire-and-forget crafting clicks that silently produce nothing (replaced by acknowledged clicks).

## Status

Early and experimental. Tool progression (wood → stone → iron → diamond depth) works across seeds; survival at night
and long-distance travel remain the weak points. Building and creative mode are new.

## Tests

```bash
npm run typecheck
npm test        # offline: acquisition planner, recipes, plan validation, blueprints
```

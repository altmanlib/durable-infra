# Architecture

This document is the map of `@altmanlib/durable-infra`: what the parts are, why they exist, and how a turn,
a notice and a setting move through them. It is deliberately a map, not a manual — each section names the
source files that carry the detail, and the code is right when the two disagree.

One half of the architecture is not described here at all: **who may import what**. That lives, as data and
as a test, in `src/architecture.ts` and is the only source for it. This document never restates the zone
table; it explains everything the table cannot say — assembly order, data flow, and the reasons behind
the seams.

## Keeping this document true

- Every section ends with the files it describes. If you change the behaviour a section describes, change
  the section in the same commit; a reviewer should be able to check the two against each other.
- Facts in this document that a machine can check, a machine should check, next to `architecture.test.ts`:
  every file path named here exists; the module roster in §10 matches the directories under `src/modules/`;
  the peer versions in §2 match `package.json`. When you add a checkable fact, add the check.
- Behaviour belongs in the section that owns it. Do not grow a second description of the same mechanism in
  another section; link instead (the turn's life is §5, delivery without an input is §6).
- Names marked as persistent identifiers (§10) are part of the architecture, not of the wording. Renaming
  one is a migration, and the changelog says so when it happens.

## 1. What this package is

Shared infrastructure for chat bots built on `@earendil-works/pi-durable`. Everything every such bot needs
is here — conversations and turns that survive a restart, delivery of answers and notices, scheduled
events, rate limits, settings an operator can change at runtime, a business database, and optional feature
modules — so that an application only adds its channels: the code that talks to the users of one service.

An entry process opens the core once with `openCore` (`src/kernel/open.ts`) and gets a `Core`: `agent`
(the conversation service, for the channels), `settings`, `prompts`, `insights` and `logs` (the query face
an operator's console reads), and `records` (the business database). `close()` closes them together,
after the channels have stopped writing.

Not here: channel transports, and the console itself. The package serves the console through its query
face; it does not contain one.

## 2. The runtime dependencies

Three packages of one family, all peer dependencies, all pinned to one exact version (see `peerDependencies` in `package.json`):

- `@earendil-works/pi-durable` — the durable substrate: sessions, documents (a base plus deltas),
  submissions and tasks, stored in SQLite. Everything in §5 and §6 stands on it.
- `@earendil-works/chord` — the execution context (`BACKGROUND_CONTEXT`) and the JSON types the documents
  are written in.
- `@earendil-works/pi-ai` — models and providers, the message types, and the faux models the tests use.

The pinning is a rule, not an accident, and it has two halves. First, the application and this package
must share **one copy** of each: the Harness, the document registry and the model registry are runtime
singletons, and two copies would be two worlds that cannot see each other. (The one ranged peer, `kysely`,
is a peer for the same reason — an application that opens tables of its own in the business database must
share the copy, or the `Kysely` types of the two sides do not meet; §9.) Second, the exact version: this
package leans on Durable behaviours that are still settling (document checkpoints, migrations), so an
unreviewed minor is not admitted by a range. Upgrading is a lockstep event — the three peers and this
package move together, and `src/probe-durable.ts` runs against the new Durable first: it probes the
behaviours the package relies on, so a silent change in them fails there and not in a running bot (§12).

Configuration names what the core needs from the environment (`src/kernel/config.ts`): the model's
OpenAI-compatible gateway (`LLM_BASE_URL`, `LLM_API_KEY`, `PI_DURABLE_MODEL`), its context window and
response limit, from which the compaction thresholds derive. Two SQLite files live side by side under the
application's data directory: `agent.sqlite` for Durable's storage and `app.sqlite` for the business
database — the reason there are two is §9.

## 3. Layers

Three layers, and a testing zone that stands outside them. The zone table in `src/architecture.ts` is the
authority; what follows is only what each layer is *for*.

- **platform** (`src/platform/`) is below everything and knows no one: structured logging with a rotating
  file, the in-process counters (sliding window, throttle) and local time. **platform/records** is a zone
  of its own inside it — the business database — which only the few who open or take the database may
  reach; it is the one place that may name `bun:sqlite`.
- **kernel** (`src/kernel/`) is the machinery: its foundations are config, prompts and the application
  documents; the settings sit below the service that opens them; the **service** runs sessions and turns
  and knows no module; **insights** reads stored data through the service and the log files by name;
  **conversation-settings** keeps the settings of a conversation, with its own records sub-zone that
  confines the Kysely types (§8, §9).
- **modules** (`src/modules/`) are the optional features of §10. Each one stands alone: it may use the
  kernel's module API and the platform, never another module. The few exceptions the table grants are
  declared in the table, with their reasons.
- **testing** (`src/testing/`) is the one place that sees everything, because fixtures assemble the real
  stack; no production code imports it.

The enforcement is a test (`src/architecture.test.ts`), not a review habit: a file that imports outside
its zone fails the suite and is told which zone it broke and why that zone is where it is.

## 4. Assembly: `openCore`

`src/kernel/open.ts` opens everything in one fixed order; the order is load-bearing, because each step
hands the next what it needs.

1. **The prompt catalog** is merged from the kernel's texts, each module's texts and the application's
   own, with the application's replacements applied; `EditablePrompts` wraps it, and the console's stored
   edits are loaded into it as the storage opens (§8).
2. **The business database** opens (`Records.open`); it has no tables yet (§9).
3. **The models** are built — the configured gateway with the application's `extraModels`, or the ones the application passes instead (`llm`). The default model and the **catalog** — the models a conversation may be moved between (§7) — are fixed here; the catalog is checked when the service opens.
4. **Each module prepares**, in the order the application listed it: with the database, the texts and the
   models it opens its tables and registers the conversation settings it owns (`Module.prepare`, §10).
5. **The conversation settings** open over the collected specs.
6. **The tool lists** are aggregated from the modules — which tools a shared conversation has, and which
   of them are privileged (§10).
7. **The change history** is made, if the application keeps its own (§8).
8. **`AgentService.open`** receives all of it, plus the extension factory: when the service builds its
   extension, each module contributes, and the parts are merged into the single extension `builtin-tools`.
   That name is stored by conversations — a persistent identifier (§10).
9. The `Core` is returned. The model switch of §7 runs inside the service's open, before work resumes.

Key files: `src/kernel/open.ts`, `src/kernel/module.ts`, `src/kernel/config.ts`.

## 5. The life of a turn

A channel addresses a conversation by a **conversation key**; a channel map ties keys to conversations
and back. `AgentService.send(key, text, requestId)` is the one door for a user's input, and the order of
its steps is the reliability story of the whole package:

1. **Admission.** A per-conversation sliding-window rate limit (default 30 inputs in 5 minutes) decides
   whether the input may start a turn. A refused input is rejected as `TurnFailed` and *nothing is
   recorded* — a refusal is never replayed. An input that is already in the outbox is always admitted:
   it was accepted once, and replay is not a new flood.
2. **Record before submit.** The input is committed to the **outbox** — a Durable document
   (`app.outbox`) listing the inputs whose answers are not yet confirmed delivered — and only then
   submitted to the conversation under its `requestId`. There is no window in which a turn exists but
   its acceptance was not recorded.
3. **The turn.** The submission runs inside Durable; `send` returns at once with a feed (the answer's
   deltas, its full text by rounds, and its tool activity) that the channel renders as it goes. The
   answer promise settles from the committed answer entry, so what the channel shows last is what was
   stored.
4. **Confirmation.** Only after the channel has actually sent the answer to the user does it call
   `delivered(key, requestId)`, which removes the input from the outbox.

Recovery is the same path run again. When a channel starts, `replayPending`
(`src/kernel/service/delivery.ts`) takes the outbox inputs of the keys the channel owns and, for each,
calls `send` with the *same* `requestId` — which returns the original turn, so the model is not run
twice and the user never receives a second, different answer — sends its text, and confirms. Inputs of
one key replay in arrival order and a failure holds back the rest of that key; keys replay in parallel;
inputs being answered right now are skipped.

So the division of labour with Durable is exact: **Durable guarantees that work it accepted is not
lost; the outbox guarantees that an input the channel accepted is not lost either.** Durable's world
ends at the session — it has no notion of a channel, or of a user who has or has not seen an answer.
The outbox is the record of that last step, kept in Durable's own storage, and an item leaves it only on
the channel's confirmation, never on the turn's completion.

Two neighbours complete the picture. `record()` writes a message the bot was not addressed by (say, in a
group) into the conversation as a stored entry — no turn, no outbox — so the model sees it with the next
question. And in a shared conversation an input carries its **speaker**; the outbox item keeps it, and
the item's submission number, so the run's inputs can be matched to their askers when the shared and
privileged tools decide who may call them (§10).

Key files: `src/kernel/service/agent-service.ts`, `src/kernel/service/outbox.ts`,
`src/kernel/service/delivery.ts`, `src/kernel/service/turn-feed.ts`,
`src/kernel/service/conversation-key.ts`, `src/kernel/service/channel-map.ts`.

## 6. Delivery without an input: notices and scheduled events

Reminders, and everything else the bot says first, travel as **notices**: an unconfirmed-deliveries
document (`app.notices`) written by core tasks and read by the channels. A channel runs `startNotices`
(`src/kernel/service/delivery.ts`), which first drains the notices an earlier run left unconfirmed and
then takes each new one as it fires, strictly in firing order. Delivery is **at least once**: a notice is
acknowledged with `ackNotice` only after it was sent, so a crash between sending and acknowledging
sends it again. A failed send retries on a short ladder (1 s, 5 s, 30 s by default) and then waits for
the next start or for `retry` — which a channel calls, for example, when the user writes again. A channel
may also declare that a failure means "sending to this user is pointless for now"; such a notice leaves
the ladder at once.

A channel can also ask to be told something at a time: `AgentService.schedule(key, at, event)` stores a
timer task on a dedicated timers conversation, and when it comes due the event arrives as a notice of
that key, under the same id. The event itself — `{ kind, data }` — is opaque: the core keeps it and
hands it back unread, and what it means is the channel's. `unschedule` answers `cancelled` or `gone`;
*gone* includes "already fired", so a channel must tolerate a notice it no longer needs, and every
notice handler must do no harm when it runs twice. The reminder module (§10) is the built-in user of
both halves: its task waits, and leaves a text notice for the channel to deliver.

Key files: `src/kernel/service/notices.ts`, `src/kernel/service/delivery.ts`,
`src/kernel/service/timers.ts`, `src/kernel/service/schedule.test.ts`.

## 7. Conversation governance

Five mechanisms keep a long-lived conversation healthy; all five are the service's, and a channel meets
them only as behaviour.

- **Compaction.** A conversation's context is summarised before it outgrows the model: the thresholds
  derive from the configured context window (§2), the summaries are entries of the conversation, and
  their cost counts in the conversation's spend. `compact(key)` runs one on demand.
- **The window.** `keepRecent` moves the context's start forward to a recent message boundary — always
  a user message, so a tool call is never parted from its result. A slack band keeps the start still
  until it is worth moving, so the provider's prompt cache is broken only once in a while; older entries
  stay in storage, only the model's view moves.
- **The tool budget.** One turn may take a bounded number of tool rounds (10 by default). When the
  budget is used up, a notice text — an editable prompt (§8) — is appended once, asking the model to wrap
  up with what it has, instead of the turn being cut off mid-work.
- **The model.** The configured model is the default of new conversations; the **catalog** is the set of
  models a conversation may be on (`openCore`'s `extraModels` or `llm.catalog`; by default just the default).
  It holds the default, and every entry is known to the models and of the default's provider — history is
  not carried across providers. A person moves one conversation with `AgentService.setModel` (`modelOf` and
  `models` read): the choice is a person's, so no tool offers it to the model, and who may choose is the
  application's to decide. The move is one Durable `configure` and applies from the conversation's next
  request: a run in flight finishes on the model it was prepared with, and a context larger than the new
  model's window is compacted before the next answer (both checked by the probe). A model outside the
  catalog is refused and nothing is written. The history (§8) gets an entry per move, area
  `conversation-model`, with the key as its target.
- **The model switch.** At open, every conversation whose stored model is not in the catalog is moved to
  the default, in one commit — forks, subagents and the timers conversation included. A conversation on
  another model of the catalog stays. A run an earlier process left unfinished keeps the model its current
  request was prepared with and asks the new model from its next prepared request. The switch is
  idempotent, and the history (§8) gets one entry per previous model, so the console can say what moved.

Key files: `src/kernel/service/agent-service.ts` (`compact`, `keepRecent`),
`src/kernel/service/tool-budget.ts`, `src/kernel/service/model-switch.ts`,
`src/kernel/service/rate-limit.ts`.

## 8. The settings surface

What an operator can change at runtime, without a restart or a release, comes in three kinds. All three
are read by the running code on every use, so an edit is in force as soon as it is stored — with one
honest exception, below.

**Prompts.** Every text that can be edited from the console lives in one catalog (`src/kernel/prompts.ts`):
system prompt sections, the instructions of internal calls, tool descriptions, and a few texts written
for the user, such as each channel's welcome. The kernel, each module and the application contribute
their groups, merged once at open (§4); code reads a text through a `PromptSource`, never as a constant,
which is what makes console edits take effect. Each entry declares its **effect** — when an edit reaches
the model: at the next request, at the next call of the step that uses it, at the next send, or only when
the tool extension is installed again (tool descriptions are read when a tool is defined, so they are
the exception to "at once"). Entries that guard against prompt injection are marked not editable: the
console may show them, but not change them. Deliberately absent from the catalog: tool parameter schemas
and the sentences inside tool results — they are tied to branching and to values filled in at run time,
so they stay next to the code that decides them.

**Allowlists.** Who may use each channel (`src/kernel/settings/access.ts`). A channel opens its list
when it starts: the first time, the list it is configured with becomes the stored one, and from then on
the stored list rules; every message asks the list, which answers from memory. Users a channel turned
away are remembered — in memory only, the most recent 50 — so the console can offer to let them in.

**The history of changes.** Settings edits, allowlist changes and model moves are recorded in a
`ChangeLog`: *committed first, noted after*. By default the history is a Durable document; an application
that keeps its own — `openCore`'s `changes`, made from the business database once that is open — takes
over the recording, and the built-in allowlist and per-channel settings then step aside for the
application's own. The history is how the console answers "who changed what, when"; it is an audit, not
an undo — a change is reversed by making the opposite change.

**Conversation settings** are the per-conversation counterpart (`src/kernel/conversation-settings/`):
values that belong to one conversation, such as which repository a group's issues go to. The kernel
knows none of them: each is registered by the module that uses it as a `SettingSpec` — a persistent
name (`<module>.<item>`, such as `gitea.repo`), a summary and a format for the model, and a `check` that
validates and normalises a new value before it is written, possibly against an outside service, under a
time limit. A failed check writes nothing, and the outcome reaches the caller as one of a small set of
results (`saved`, `invalid_value`, `rejected`, `check_failed`, …). Values are stored as text in the
business database and decoded by their spec when read; the settings-tools module (§10) exposes listing,
setting and clearing them to the model as tools.

Key files: `src/kernel/prompts.ts`, `src/kernel/settings/`, `src/kernel/conversation-settings/`
(`spec.ts`, `catalog.ts`, `settings.ts`, `records/`).

## 9. The business database

Two stores, two kinds of truth. Durable's storage (§5) holds the conversations — state that must be
committed together with the turns that change it. The business database holds records that keep growing
and are looked up by field — conversation settings, memos, an application's own tables — which need no
atomicity with a turn. That, and nothing else, is why `app.sqlite` exists beside `agent.sqlite`.

`Records` (`src/platform/records/`) holds the file and no schema: each domain brings its tables with
`records.tables(domain, migrations)`. Domains are independent on purpose:

- each domain keeps its own migration table and numbers its steps apart (`0001_…`, plain SQL, run as one
  transaction, so a failed step leaves nothing behind);
- every table and index a step creates must carry the domain's prefix (`<domain>_`), and this is
  verified after the migration runs — a stray name fails the open;
- a database whose steps the code does not know is **ahead of the code and refused**: older code would
  write to a shape it does not understand;
- a step that has been released is never edited — a change of shape is the next step, because the
  database holds real records.

Health is observed from Kysely's log: reads and writes are tracked apart (a full disk still reads), a
constraint error is the caller's and not a failure, and a success after a failure is logged as recovery.
The file itself is opened in WAL mode with a busy timeout, so a reader never waits for the one writer.

The Kysely surface is confined by zone (§3): domains receive a typed view (`withTables`) of the one
database, and the query builder's types stay inside the records zones — the rest of the package works
with rows decoded by their owners.

## 10. Modules

A module is a feature an application opens or leaves out. The contract (`src/kernel/module.ts`) is all
there is to one: a name, its prompt entries, the names of its tools, and two hooks that follow the
assembly of §4.

- `prepare` runs when the core opens, before the conversation settings: the module opens its tables in
  the business database and returns the conversation settings it owns.
- `contribute` runs when the extension is built, with the settings and the harness open: it returns its
  **contribution** — tools, system-prompt sections, and tasks (durable generation tasks, such as the
  one that waits for a reminder's time).

The contributions of all the modules are merged into the one `builtin-tools` extension. A module declares
each of its tools once, as a `ToolSpec`, on two independent axes: its **scope** (`everywhere`, or
`shared-only` for a tool a one-to-one conversation is not offered, which is also `deferred` on the tool)
and its **access** in a shared conversation (`anyone`, or `privileged` for a tool that changes state —
reminders are the example). A tool the configuration leaves out is declared `off` with a note, such as
the search tool without a provider. The names a shared conversation is given are derived from the
specs (`sharedToolNames`); without any declaration, a shared conversation has every tool. A module never
uses another module; the kernel knows none of them.

The same declarations are what an operator reads: `describeTools` and `formatToolCatalog`
(`src/kernel/tool-catalog.ts`) list every tool of an application's modules, for one person and for a
group, without opening storage or a model. A test builds each module's real contribution and holds it to
its specs, so the declaration cannot drift from the tools.

The roster today:

| Module | What it adds | Notes |
| --- | --- | --- |
| `clock` | The time and the application status | Read-only facts; shared |
| `reminder` | Reminders that fire as notices (§6) | Privileged: setting one changes state |
| `web` | `web_fetch` and `web_search` | Shared, read-only; no search tool without a provider |
| `memo` | The memo of a shared conversation | Own table in the business database |
| `settings-tools` | List, set and clear conversation settings (§8) | The model's door to the specs modules register |
| `gitea` | Work with issues on a group's Gitea: file, list, read, comment, edit | Its target is the conversation setting `gitea.repo` |

Two of them show the shape of the outside world in this design. The web module's fetcher refuses this
machine and private networks by default, its page answers come from a summariser (by default one call of
the conversations' own model, without tools), and its search sits behind the `SearchProvider` interface
— Tavily is the built-in provider, and any other must pass the same contract tests (§11). The gitea
module is a client, a setting and the five issue tools, and nothing more.

**Persistent identifiers.** A module's tool names, task names, prompt ids, setting names and table
names, the provider and id of every model in a catalog (conversations store them), the `builtin-tools` extension name, conversation keys, and the `kind` of every application
document are stored — in conversations, in stored edits, in the database. **Never rename a released
one.** When a rename is unavoidable, the old name is migrated as the core or the conversation opens
(the precedent is `moveToSharedTools`, which carried shared conversations over the gitea tool's rename),
and the changelog says it happened.

Key files: `src/kernel/module.ts`, `src/modules/` (one directory per module),
`src/kernel/service/shared-tools.ts`.

## 11. Testing

The suite tests the real stack and fakes only the two boundaries that cannot be real: the model, and
outside services.

- **The model** is pi-ai's faux provider: scripted answers, queued per test, over the real service, the
  real modules and a real database in a temporary directory (`src/testing/testing.ts` assembles the
  fixtures: the full prompt catalog of kernel and modules, the settings, log capture).
- **Outside services** get fakes that behave like the service, including its failures.
  `src/testing/fake-gitea.ts` is a real HTTP server that answers as Gitea does — renamed repositories
  with a 301, hangs, garbage, closes — and records what it was asked, authorization header included.
- **Contract tests** pin the rules every implementation of an interface keeps.
  `src/testing/search-contract.ts` is the executable form of the search contract: a provider-neutral
  set of scenarios (hits, garbage, each documented failure kind, a backend that never answers) and the
  assertions every `SearchProvider` must satisfy — never more hits than asked, errors normalised to one
  type with a kind, declared capabilities, and no leaking. Both fakes carry **canary secrets** (a token,
  a private query) that tests search for in logs and errors: the secret a test can find is a leak.
- **The layers** are tested by `src/architecture.test.ts` (§3), and **Durable's contract** by the probe
  (§2) — the two assumptions the rest of the suite stands on each have a dedicated check.

`bun run verify` is the gate: Biome, the type check and the tests; `publint` checks the published
package shape.

## 12. Versioning and upgrading

A release is a tag: `bun run release` aligns `main` with `dev`, bumps the version and pushes
`v<version>`, and the Release workflow publishes that tag. Two upgrade rules follow from §2 and §9, and
both are about not stranding a running bot:

- **The earendil peers move together.** Bump the three pins and this package in one change, run the
  probe, then `verify`. Applications then bump their pins in the same lockstep; an application that
  moves first gets peer complaints, by design.
- **The business database only moves forward.** Because a database ahead of the code is refused (§9),
  deploying older code against a migrated database fails loudly at open rather than corrupting quietly
  — so a rollback of the application is a restore of the database, not just of the code.

# A CRUD feature over REST in a created project, 2026-10-05

The [earlier feature runs](starter-test-2026-10-04.md) all extended the
starter's own example: more data over the same WebSocket. This one asks for
something the starter has no example of: two entities with create, edit and
delete, forms with validation, and a second transport (REST, with a server
framework the starter does not use).

The result is public:
[bettersoftware-io/skills-demo](https://github.com/bettersoftware-io/skills-demo),
[pull request 1](https://github.com/bettersoftware-io/skills-demo/pull/1).

## Setup

- The project from [the GitHub run](github-run-2026-10-05.md): created by the
  script, with the three add-ons, green on GitHub.
- One fresh headless Claude Code session (`claude -p`), **Claude Opus 5.5**,
  started in the project folder. The earlier runs used Claude Fable 5.1.
- The project's own `AGENTS.md` and hooks were active. No skill from this
  repository was installed. The user's usual plugins were loaded; the session
  loaded two of their skills (`superpowers:brainstorming`,
  `postman:api-engineer`).
- The prompt described the feature and named Hono. It said nothing about
  architecture.

### The prompt

> Build a small user-management app in this project.
>
> Categories. Each has a name. A person can see the list, add a category,
> rename one and delete one. A name cannot be empty, and no two categories
> share a name (ignoring case). A category that still has users cannot be
> deleted, and the app says why.
>
> Users. Each has a name, an email address and exactly one category. A person
> can see the list, add a user, edit one and delete one, and can narrow the
> list to one category. A name cannot be empty. The email must look like an
> email address, and no two users share one (ignoring case).
>
> The data lives on the server, behind a REST API (JSON over HTTP) built with
> Hono. The server keeps it in memory and starts with a few categories and
> users. The app must also work with no server, as it does today with
> `pnpm dev`.
>
> When the server refuses a change, or a field is invalid, the message appears
> next to the form that caused it.
>
> Implement it with tests. Leave the price list as it is. Do not commit.

## Results

| | |
|---|---|
| Time and cost | 20 min, 141 turns, $7.19 |
| Files | 68: 33 new and 28 changed, plus 7 golden images (3 new, 4 redrawn); 4,699 lines added |
| Rules, gates, lint config or hooks edited | none |
| Full gate, run again independently | pass: 231 tests (the starter has 55), per-file coverage gate included |
| Independent review with `reviewing-architecture` (Claude Fable 5.1, $4.60) | PASS, seven of seven OK |
| Hook blocks in the session log | none |
| Its own mutation check | 21 planted, 20 caught; the survivor was dead code, which it removed |

What it built, by layer:

- **Domain:** a `DirectoryPort` in domain words, with an `Outcome` type (a
  change is accepted with its result, or refused with a reason, a field and a
  message). The rules are use cases. A simulator implements the port, with a
  contract test.
- **Shared:** the REST protocol: paths, DTOs, encoders, and one table from
  refusal reason to HTTP status.
- **Core:** a `fetch` adapter that passes the same contract, a presenter (one
  shared load for three components, derived counts and names), and a form
  state machine.
- **Server:** Hono routes that hold no rule. They turn a request into a call
  on the port and the outcome into a status. The server's data is the domain's
  simulator, so the server and the no-server mode refuse the same things with
  the same words.
- **UI:** dumb components, tested through page objects, with three new visual
  scenarios.

None of the structural mistakes from the [baseline run](baseline-2026-10-04.md)
appeared.

## Checked by hand afterwards

The session said it could not drive a browser. Checked here:

- The real server, with `curl`: lists, an accepted add, and refusals for a
  duplicate name in another case (409), an empty name (422), a bad email
  (422), a body that is not JSON (422), a category in use (409) and an unknown
  path (404).
- The real client against the real server, in headless Chromium: add a
  category, a refused delete with its message, a refused bad email, a refused
  duplicate email in another case, an accepted user, the list narrowed to one
  category. The server held the new user afterwards. The price list kept
  streaming.

## What the review found outside the seven questions

None of these is architectural, and no gate could have caught them.

| Finding | Status |
|---|---|
| The in-memory directory could give a new entry the id of a deleted one | Confirmed with a failing test, fixed in the pull request |
| A `not-found` refusal leaves the dead row on screen | Open |
| A failed reload after a successful change blanks both lists, and what was typed is lost | Open |
| The API accepts any origin and has no authentication | Open; said by the session itself |
| The fake server in the adapter's tests repeats the route table of the real one; no test runs the real adapter against the real routes | Open |
| One message in the domain says "the server" | Open |
| Three transport types exported from the core and used nowhere else | Open |

## What this says about the starter

- **A second transport needed nothing new from the starter.** The port,
  contract, simulator and adapter pattern carried over from WebSocket to REST
  without an example of REST to copy.
- **The layer rule pushed the wire format into `shared`.** The client may not
  import the server, so both sides meet at the protocol. The cost is the open
  finding above: nothing runs the two ends against each other.
- **`AGENTS.md` was not updated.** Its table of patterns still points only at
  the price list. Nothing asks an agent to add a new pattern (a request and
  response port, a form machine) to that table.
- **Still no implement skill is warranted.** The failures were ordinary bugs,
  found by review and by using the app, not misplaced code.

## The pull request on GitHub

This was also the first pull-request run of the add-ons' workflows.

| Workflow | On the feature commit | After the Linux goldens were committed |
|---|---|---|
| `CI` | pass | pass |
| `Coverage` | pass | pass |
| `Motion audit` | pass (skip: still no animation) | pass (skip) |
| `Visual goldens` | **fail, as designed**: every old image differs and three have no golden | pass |

`Update visual goldens` was dispatched on the branch, its artifact brought in
with the two commands from the job summary, and committed. The pull request
was then merged.

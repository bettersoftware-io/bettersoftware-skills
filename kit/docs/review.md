# Reviewing architecture

The gates check what a machine can check. This review covers what they
cannot: seven judgement questions. The report answers all seven, including the
ones that pass.

## 1. Run the gates first

Run `node tools/arch/gates/run.mts` and the project's lint. Paste their output
into the report unchanged, and do not re-derive what a gate already reports.

- If they cannot run, the report says "not run" and why. Not run is not passed.
- A `SKIP` line means that gate judged nothing. Read its reason as a lead.
- If the project's dependencies are not installed, lint, typecheck and tests
  are "not run: dependencies not installed". A review installs nothing: a
  package script can install as a side effect, so it is not run either.

## 2. Answer the seven questions

For each, give the evidence as `file:line`, then FINDING or OK.

1. **Who owns each port?** Find every interface an adapter implements: a data
   source, storage, a clock, a transport.
   - FINDING: it is declared in an adapter's file, in a client, or in the
     wire-protocol package; or an adapter takes a port's types from another
     adapter instead of from the domain.
   - OK: it is declared in the domain package's ports folder.
2. **Is the port in domain words or wire words?**
   - FINDING: the port's type is, or contains, a wire message; it carries
     transport events (open, closed, snapshot, ack); a simulator has to
     fabricate transport messages to satisfy it.
   - OK: the port speaks in entities, and the adapter maps wire to domain.
3. **Is there one composition root per app?**
   - FINDING: configuration is read, an adapter is chosen or a stream is built
     at module scope or inside a component; or two places choose adapters.
4. **Does derived business meaning live in the core?**
   - FINDING: a component computes a value with business meaning from raw
     data: a delta, a trend, a total, a status, an ordering that matters.
   - OK: presentation only — formatting a number, picking a class from a value
     the core already computed.
5. **Is state shared?**
   - FINDING: a stream the UI subscribes to is cold, so a second subscriber
     would open a second connection or start a second set of timers.
6. **Does every seam earn its place?**
   - FINDING: an interface with one implementation and no simulator or test
     double; or two implementations with no contract test run against both.
   - OK: one real adapter plus a simulator that tests use.
7. **Do tests go through the interface their caller uses?**
   - FINDING: a UI test asserts on markup, class names or a pattern over HTML
     instead of a page object; a fixture factory with a bare-noun name instead
     of `create…`; a test that waits on real time; an adapter with no test.

## 3. Report in this shape

```
## Verdict: PASS | CHANGES NEEDED

## Gates
<their output, unchanged — or "not run: <reason>">

## Judgement
1. Port ownership — FINDING | OK
   <file:line> <what is there> → <the smallest change that fixes it>
2. Port vocabulary — …
3. Composition root — …
4. Derived meaning — …
5. Shared state — …
6. Seams — …
7. Tests — …

## Other
<anything else worth saying: robustness, security, performance>

## Not reviewed
<what was not looked at, and why>
```

The verdict is CHANGES NEEDED when a gate fails or any question is a FINDING.

## Ground rules

- Review only. Change nothing unless asked.
- Other problems go under **Other**. They never take the place of a question.
- If the code under review was written in this conversation, hand the review to
  a reviewer that did not write it, and relay what it reports.
- If the project is not built on ports and adapters, say so and stop: these
  questions do not apply.

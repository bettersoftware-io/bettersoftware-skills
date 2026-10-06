# Security policy

How to report a security problem in this repository and in the `@app/*`
packages built from it, and what counts as one.

<!--
For the maintainers. This file is yours: the add-on wrote it once and will not
touch it again. Before the repository is public:

1. Switch on private vulnerability reporting (Settings, Advanced Security).
   Without it the "Report a vulnerability" button below does not exist. If you
   cannot switch it on, replace that paragraph with an address people can
   write to.
2. Change the two times under "What to expect" to times you will keep.
3. Change "Supported versions" once the project has releases.
-->

## Reporting a vulnerability

Report it in private. On this repository's page on GitHub, open **Security**,
then **Report a vulnerability**. GitHub's guide to
[privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
shows the steps.

Do not open a public issue or pull request for a suspected vulnerability, and
do not disclose it anywhere else before a fix is out.

Say what you found, where it is (a file, a workflow, an address), how to
reproduce it, and which commit you looked at.

## What to expect

- An answer within 7 days.
- If the report is confirmed: a fix or a plan, and a date for public
  disclosure agreed with you, at most 90 days after your report.
- Your name in the advisory, unless you ask to be left out. There is no bounty.

## In scope

- The code in this repository, and what is built from it.
- Its GitHub Actions workflows and its build and release configuration
  (`.github/`, `tools/`, the lockfile).
- A dependency used here in a way that makes a flaw in it exploitable here.

## Out of scope

- A flaw in a dependency with no shown effect on this project. Report it to
  that project. Known advisories are already tracked here.
- The output of a scanner with no shown way to exploit what it found.
- Denial of service by volume alone.
- Anything that needs a maintainer's account, machine or secrets to begin with.

## Supported versions

Only the newest commit on `main` is supported. There are no releases yet.

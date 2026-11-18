# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting. On github.com/oleharland/Almagest,
open the **Security** tab and choose **Report a vulnerability**. Please do not
open a public issue, pull request or discussion for a vulnerability, and do not
post details anywhere public until it has been fixed.

## What is most useful to hear about

Almagest's central promise is that nothing reaches `brain/wiki/` on `main`
unless a human approved the exact version they were shown. The reports that
matter most are the ones that break it:

- a way to get a change into `brain/wiki/` on `main` without a human approving
  the exact version shown (`headSha`);
- a way for an agent, the headless ingest agent or a chat connected over MCP, to
  approve a proposal, or to move `main` itself;
- a flaw in the service's sign-in, sessions, CSRF protection or API tokens, or
  in how roles are checked at approval and merge time;
- a bypass of the audit: a page that should fail `tools/audit.mjs` and passes.

Other bugs in `server/`, `tools/` and `site/` are welcome too. If you are unsure
whether something counts, report it privately and say so.

## What is already known

[`docs/v2/security.md`](docs/v2/security.md) lists the limits we know about
under "Known limits", so reports of them are not new. The main one: a process
that can run arbitrary code as your user can edit `.git/`, unset the markers
the guards rely on, and read the service's secrets. The guards cover the
commands an agent is normally given, and only OS-level separation (a different
user, a container, or another machine) closes the rest.

## Status

The `server/` service is new. It has been reviewed and tested, including
exploit-driven review rounds with regression tests, but it has not yet been run
widely, and you should expect to find things we missed. The framework without
the service (an agent session, git and `tools/audit.mjs`) is much smaller and
has no network surface. Before you run the service anywhere other people can
reach it, work through the hardening checklist in
[`docs/v2/security.md`](docs/v2/security.md).

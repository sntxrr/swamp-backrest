# @sntxrr/backrest

Keep a [Backrest](https://github.com/garethgeorge/backrest) server's snapshot
index current for restic repositories it does not itself back up, and report how
fresh each one is.

## The problem it solves

Backrest indexes snapshots only for repositories it runs backups *for*. A
repository that is merely **configured** — the normal shape when restic runs
from systemd timers on each host and Backrest is only the console — is never
indexed at all.

It reports no error while doing this. The repository simply stays empty, which
reads as "No backups yet" for a host whose backups are current and verified.
The failure is invisible in exactly the direction that matters: the console you
would check in an incident is the one telling you nothing is there.

This model asks Backrest to index on a schedule, and reports what it found.

## What it does not fix

Indexing populates the **repository view** — tree, list and stats. It does not
populate the **summary dashboard**, whose cards count backup operations Backrest
performed itself. Snapshots indexed from an external restic are a different
record type and are not counted there. A repository backed up by a systemd timer
will keep reading "No backups yet" on the dashboard however often it is indexed.

Making those cards reflect the fleet requires Backrest to be the thing running
the backups. That is a different change, and this model does not pretend to be
it.

## Methods

| Method    | Effect                                                                     |
| --------- | -------------------------------------------------------------------------- |
| `sync`    | Read-only. Reports each repository's newest indexed snapshot.               |
| `reindex` | Triggers `TASK_INDEX_SNAPSHOTS` for every repository, waits, then reports.  |

`reindex` is the one to schedule. Both are safe against a live server:
`TASK_INDEX_SNAPSHOTS` reads a repository's index and cannot create, forget or
prune a snapshot.

## Status values

| Status      | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `ok`        | Newest snapshot is within `maxSnapshotAgeHours`.                   |
| `stale`     | Snapshots exist but have stopped advancing — a backup has stopped. |
| `unindexed` | No snapshot at all — this server has never read the repository.    |

`stale` and `unindexed` are deliberately not merged. They have different causes
and different fixes: `stale` is a backup that stopped running on the host,
`unindexed` is almost always a credential *this Backrest instance* holds that no
longer exists. Collapsing them into one count hides which you are looking at.

## Usage

```bash
swamp model create @sntxrr/backrest/instance backrest \
  --global-arg apiUrl=http://backrest.internal:9898

swamp model @sntxrr/backrest/instance method run reindex backrest
```

With an authenticated instance, pass the token from a vault rather than inline:

```bash
swamp model create @sntxrr/backrest/instance backrest \
  --global-arg apiUrl=http://backrest.internal:9898 \
  --global-arg 'apiKey=${{ vault.get("backrest", "API_TOKEN") }}'
```

Point `apiUrl` at an address that serves the API directly. An instance behind an
SSO proxy answers with an HTML login page, which the model reports as such
rather than letting it parse as an empty fleet.

## Global arguments

| Argument                | Default | Notes                                                     |
| ----------------------- | ------- | --------------------------------------------------------- |
| `apiUrl`                | —       | Required. Base URL, no trailing slash needed.             |
| `apiKey`                | —       | Bearer token. Omit when auth is disabled.                 |
| `requestTimeoutSeconds` | `30`    | Per API call, not the settle wait.                        |
| `settleTimeoutSeconds`  | `900`   | Budget for every repository to appear. See below.         |
| `pollIntervalSeconds`   | `10`    | How often to re-read the operation log while waiting.     |
| `maxSnapshotAgeHours`   | `48`    | Older than this is `stale`.                               |
| `excludeRepos`          | `[]`    | Repository ids to leave alone.                            |

`settleTimeoutSeconds` deserves a note. Backrest indexes serially, so one
repository it cannot read holds up every repository queued behind it — measured
at six and a half minutes for a revoked B2 key. A repository the server can
never read never appears, so it consumes this entire budget on every run. The
remedy is to repair its credentials or list it in `excludeRepos`, not to shorten
the timeout, which would only start cutting off healthy repositories too.

## Server behaviours worth knowing

Four things about Backrest's API shape this model. Each one silently produces a
wrong answer if you build against the API as documented rather than as observed.

1. **`GetOperations`' `repoId` selector does not filter.** A selector that
   matches nothing returns the *entire* operation log rather than an empty set.
   Query per repository and every repository reports the whole fleet's totals,
   identically, which looks plausible and is wrong. Fetch once; group on each
   operation's own `repoId`.

2. **A failed index task leaves no record.** Only successful operations are
   logged. Through the API alone, a repository the server cannot read is
   indistinguishable from one whose task has not run yet. Both are reported here
   as `unindexed`, with the reason named as the server log rather than guessed.

3. **The queue is serial and one stuck repository blocks the rest.** Triggering
   N repositories enqueues N tasks. A stalled one does not fail fast.

4. **A stalled task looks exactly like a deadlock and is not one.** The restic
   process sleeps with no CPU time, stdin on `/dev/null` and no sockets open,
   because it is between exponential retries rather than working. Inspecting the
   process proves nothing; only the eventual error does.

## Licence

MIT — see `LICENSE.md`.

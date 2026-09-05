/**
 * Backrest instance — keep a Backrest server's snapshot index current for
 * repositories it does not itself back up, and report how fresh each one is.
 *
 * Backrest indexes snapshots only for repositories it runs backups for. A
 * repository that is merely *configured* — the normal shape when restic runs
 * from systemd timers on each host and Backrest is only the console — is never
 * indexed at all. It reports no error while doing so: the repository simply
 * stays empty in the UI, which reads as "no backups" for a host whose backups
 * are in fact current. This model closes that gap by asking Backrest to index
 * on a schedule, and then reporting what it actually found.
 *
 * Both methods are safe to run against a live server. `sync` only reads.
 * `reindex` triggers Backrest's own `TASK_INDEX_SNAPSHOTS`, which reads a
 * repository's index and writes nothing to it — it cannot create, forget or
 * prune a snapshot.
 *
 * Four behaviours are driven by how Backrest actually behaves rather than by
 * how its API reads, and each one silently produces a wrong answer if ignored:
 *
 * 1. **`GetOperations`' `repoId` selector does not filter.** A selector that
 *    matches nothing returns the ENTIRE operation log rather than an empty
 *    set, so asking per repository and trusting the response makes every
 *    repository report the same total — the fleet's, not its own. This model
 *    therefore fetches once and groups client-side on each operation's own
 *    `repoId`, which is the only field that actually distinguishes them.
 *
 * 2. **A failed index task leaves no trace in the operation log.** Only
 *    successful operations are recorded, so a repository Backrest cannot read
 *    is indistinguishable, through the API alone, from one whose task has not
 *    run yet. Both simply have no operations. This model does not pretend
 *    otherwise: it reports such a repository as `unindexed` and says plainly
 *    that the reason lives in the server log, rather than inventing a cause.
 *
 * 3. **The task queue is serial, and one stuck repository blocks the rest.**
 *    Triggering N repositories does not run N tasks; it enqueues them behind
 *    each other. A repository whose credentials have been revoked does not
 *    fail fast — restic retries with exponential backoff for six minutes or
 *    more, and everything queued behind it waits. `reindex` therefore triggers
 *    everything first and then polls to a deadline, reporting what it managed
 *    to observe rather than assuming the queue drained.
 *
 * 4. **An empty repository and a stale one are different failures.** A
 *    repository with no indexed snapshot at all has never been readable by
 *    this Backrest instance — typically a credential it holds that no longer
 *    exists. A repository with snapshots that have stopped advancing is a
 *    backup that has stopped running. Folding both into one "not ok" count
 *    hides which of the two is happening, so they are counted separately as
 *    `unindexed` and `stale`.
 *
 * Because it reaches the repositories over a wholly separate path — Backrest's
 * stored credentials, not the ones the backup hosts use — a disagreement
 * between this model and the host-side view is informative rather than noise:
 * it means exactly one of the two credential sets has gone bad.
 *
 * @module
 */
// extensions/models/backrest_instance.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiUrl: z.string().url().describe(
    "Base URL of the Backrest API, e.g. http://backrest.internal:9898. No trailing slash needed. Prefer an address reachable directly; a URL fronted by an SSO proxy answers with an HTML login page rather than JSON.",
  ),
  apiKey: z.string().optional().meta({ sensitive: true }).describe(
    "Bearer token, when the instance has authentication enabled. Omit for an instance with auth disabled. Supply it from a vault rather than inline — marking it sensitive keeps it out of logs, but the stored model config still holds whatever literal you pass.",
  ),
  requestTimeoutSeconds: z.number().int().positive().max(300).default(30)
    .describe(
      "Per-request timeout. Applies to each API call, not to the settle wait.",
    ),
  settleTimeoutSeconds: z.number().int().positive().max(3600).default(900)
    .describe(
      "How long `reindex` waits for every repository to appear before reporting. A repository Backrest cannot read never appears, so it consumes this whole budget on every run — repair its credentials or add it to `excludeRepos` rather than shortening this, which would only start cutting off healthy repositories too.",
    ),
  pollIntervalSeconds: z.number().int().positive().max(120).default(10)
    .describe("How often to re-read the operation log while waiting."),
  maxSnapshotAgeHours: z.number().positive().default(48).describe(
    "A repository whose newest indexed snapshot is older than this is reported `stale`. The default allows a full missed daily backup plus most of a second day, so a single late run does not read as a failure.",
  ),
  excludeRepos: z.array(z.string()).default([]).describe(
    "Repository ids to leave alone. Use for repositories Backrest backs up itself — it already indexes those on its own schedule — and for any it is known to be unable to read.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RepoStatusSchema = z.object({
  repoId: z.string(),
  status: z.enum(["ok", "stale", "unindexed"]),
  snapshotCount: z.number().int(),
  latestSnapshotAt: z.string().nullable(),
  ageHours: z.number().nullable(),
  movedThisRun: z.boolean(),
});

const FleetSchema = z.object({
  apiUrl: z.string(),
  checkedAt: z.string(),
  reindexed: z.boolean(),
  waitedSeconds: z.number(),
  allObserved: z.boolean(),
  maxSnapshotAgeHours: z.number(),
  total: z.number().int(),
  ok: z.number().int(),
  stale: z.number().int(),
  unindexed: z.number().int(),
  problemRepos: z.array(z.string()),
  repos: z.array(RepoStatusSchema),
});

type Fleet = z.infer<typeof FleetSchema>;
type RepoStatus = z.infer<typeof RepoStatusSchema>;

type Logger = {
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn: (message: string, properties?: Record<string, unknown>) => void;
};

type Context = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/* ------------------------------------------------------------------ *
 * API access
 *
 * Backrest speaks Connect over POST with a JSON body, so every call is the
 * same shape and only the method name and payload change.
 * ------------------------------------------------------------------ */

/** One repository as Backrest's config reports it. */
type ConfigRepo = { id?: unknown };

/** One entry from the operation log. Only the fields used here are typed. */
type Operation = {
  repoId?: unknown;
  operationIndexSnapshot?: { snapshot?: { unixTimeMs?: unknown } };
};

/** Newest indexed snapshot and how many were seen, per repository. */
type Observed = Map<string, { latestMs: number; count: number }>;

/**
 * Build a Connect endpoint URL, tolerating a trailing slash on the base.
 *
 * @param apiUrl Base URL of the Backrest server.
 * @param method Connect method name, e.g. `GetConfig`.
 * @returns The absolute URL to POST to.
 */
export function endpoint(apiUrl: string, method: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1.Backrest/${method}`;
}

async function call(
  globalArgs: GlobalArgs,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (globalArgs.apiKey) {
    headers["Authorization"] = `Bearer ${globalArgs.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint(globalArgs.apiUrl, method), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(globalArgs.requestTimeoutSeconds * 1000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Backrest ${method} at ${globalArgs.apiUrl} could not be reached: ${detail}`,
    );
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Backrest ${method} returned HTTP ${response.status}: ${
        text.slice(0, 300)
      }`,
    );
  }

  // An instance behind an SSO proxy answers 200 with an HTML login page rather
  // than failing, so a successful status is not on its own proof of an API.
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Backrest ${method} did not return JSON. This usually means ${globalArgs.apiUrl} is fronted by a login page rather than the API itself. First bytes: ${
        text.slice(0, 120)
      }`,
    );
  }
}

/** Repository ids Backrest is configured with, minus any excluded. */
async function listRepos(globalArgs: GlobalArgs): Promise<string[]> {
  const config = await call(globalArgs, "GetConfig", {}) as {
    repos?: ConfigRepo[];
  };
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const ids = repos
    .map((repo) => repo?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (ids.length === 0) {
    throw new Error(
      `Backrest at ${globalArgs.apiUrl} reports no configured repositories. Nothing to index.`,
    );
  }

  const excluded = new Set(globalArgs.excludeRepos);
  return ids.filter((id) => !excluded.has(id));
}

/**
 * Group the operation log by repository, in one call.
 *
 * Deliberately not asked per repository: `GetOperations`' selector silently
 * returns the whole log when it matches nothing, so a per-repository query
 * reports the entire fleet's operations as though they belonged to that one
 * repository. Each operation's own `repoId` is the only trustworthy key.
 */
export function groupSnapshots(operations: Operation[]): Observed {
  const byRepo: Observed = new Map();

  for (const operation of operations) {
    if (!operation?.operationIndexSnapshot) continue;

    const repoId = operation.repoId;
    if (typeof repoId !== "string" || repoId.length === 0) continue;

    // Backrest serialises 64-bit fields as JSON strings.
    const raw = operation.operationIndexSnapshot.snapshot?.unixTimeMs;
    const ms = typeof raw === "string"
      ? Number(raw)
      : typeof raw === "number"
      ? raw
      : Number.NaN;
    if (!Number.isFinite(ms) || ms <= 0) continue;

    const existing = byRepo.get(repoId);
    if (existing) {
      existing.count += 1;
      if (ms > existing.latestMs) existing.latestMs = ms;
    } else {
      byRepo.set(repoId, { latestMs: ms, count: 1 });
    }
  }

  return byRepo;
}

async function readSnapshots(globalArgs: GlobalArgs): Promise<Observed> {
  const result = await call(globalArgs, "GetOperations", {
    selector: {},
    lastN: "10000",
  }) as { operations?: Operation[] };

  return groupSnapshots(
    Array.isArray(result.operations) ? result.operations : [],
  );
}

/* ------------------------------------------------------------------ *
 * Assessment
 * ------------------------------------------------------------------ */

/**
 * Decide whether the picture has stopped changing between two polls.
 *
 * Settled means both halves: every requested repository has been seen at least
 * once, AND none of them gained a newer snapshot since the previous poll. The
 * second half is what stops a healthy fleet — where every repository already
 * has snapshots — from being declared settled before the tasks just triggered
 * have landed, which would report the state from before the trigger.
 *
 * @param requested Repositories this run asked to index.
 * @param previous Newest snapshot per repository at the previous poll.
 * @param observed Newest snapshot per repository at this poll.
 * @returns Whether all were seen, whether any advanced, and the conjunction.
 */
export function isSettled(
  requested: string[],
  previous: Observed,
  observed: Observed,
): { allObserved: boolean; advanced: boolean; settled: boolean } {
  const allObserved = requested.every((repoId) => observed.has(repoId));
  const advanced = requested.some((repoId) => {
    const now = observed.get(repoId)?.latestMs;
    const then = previous.get(repoId)?.latestMs;
    return now !== undefined && (then === undefined || now > then);
  });
  return { allObserved, advanced, settled: allObserved && !advanced };
}

/**
 * Classify each requested repository against the freshness limit.
 *
 * A repository absent from `observed` is `unindexed` rather than merely old:
 * this server has never read it at all, which is a different fault from a
 * backup that has stopped advancing.
 *
 * @param repoIds Repositories to report on, in the order to report them.
 * @param observed Newest snapshot per repository, from {@link groupSnapshots}.
 * @param baseline Newest snapshot per repository before this run, for movement.
 * @param now Epoch milliseconds to measure age against.
 * @param maxAgeHours Ages beyond this are `stale`; the boundary itself is `ok`.
 * @returns One status per requested repository.
 */
export function assess(
  repoIds: string[],
  observed: Observed,
  baseline: Map<string, number>,
  now: number,
  maxAgeHours: number,
): RepoStatus[] {
  return repoIds.map((repoId) => {
    const entry = observed.get(repoId);

    if (!entry) {
      return {
        repoId,
        status: "unindexed" as const,
        snapshotCount: 0,
        latestSnapshotAt: null,
        ageHours: null,
        movedThisRun: false,
      };
    }

    const ageHours = (now - entry.latestMs) / 3_600_000;
    const before = baseline.get(repoId);

    return {
      repoId,
      status: ageHours > maxAgeHours ? ("stale" as const) : ("ok" as const),
      snapshotCount: entry.count,
      latestSnapshotAt: new Date(entry.latestMs).toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      movedThisRun: before === undefined || entry.latestMs > before,
    };
  });
}

/**
 * Roll per-repository statuses into the recorded fleet summary.
 *
 * `stale` and `unindexed` are counted separately on purpose — they have
 * different causes and different fixes, and one total hides which is happening.
 *
 * @param apiUrl Server the reading came from.
 * @param maxAgeHours Freshness limit applied, recorded so the result is self-describing.
 * @param statuses Per-repository statuses from {@link assess}.
 * @param reindexed Whether this run triggered indexing or only read.
 * @param waitedSeconds How long the settle wait actually took.
 * @param allObserved Whether every requested repository was seen at least once.
 * @returns The fleet record written to the `fleet` resource.
 */
export function summarise(
  apiUrl: string,
  maxAgeHours: number,
  statuses: RepoStatus[],
  reindexed: boolean,
  waitedSeconds: number,
  allObserved: boolean,
): Fleet {
  const problem = statuses.filter((s) => s.status !== "ok");
  return {
    apiUrl,
    checkedAt: new Date().toISOString(),
    reindexed,
    waitedSeconds,
    allObserved,
    maxSnapshotAgeHours: maxAgeHours,
    total: statuses.length,
    ok: statuses.filter((s) => s.status === "ok").length,
    stale: statuses.filter((s) => s.status === "stale").length,
    unindexed: statuses.filter((s) => s.status === "unindexed").length,
    problemRepos: problem.map((s) => s.repoId).sort(),
    repos: statuses,
  };
}

function report(logger: Logger, fleet: Fleet): void {
  logger.info(
    "{ok}/{total} repositories have a snapshot newer than {limit}h",
    { ok: fleet.ok, total: fleet.total, limit: fleet.maxSnapshotAgeHours },
  );

  for (const repo of fleet.repos) {
    if (repo.status === "unindexed") {
      logger.warn(
        "{repoId} has no indexed snapshot. Backrest has never successfully read this repository — a failed index task leaves no record in the operation log, so the reason is in the Backrest server log, most often a credential it still holds that no longer exists.",
        { repoId: repo.repoId },
      );
    } else if (repo.status === "stale") {
      logger.warn(
        "{repoId} last backed up {ageHours}h ago, past the {limit}h limit",
        {
          repoId: repo.repoId,
          ageHours: repo.ageHours,
          limit: fleet.maxSnapshotAgeHours,
        },
      );
    }
  }

  if (fleet.reindexed && !fleet.allObserved) {
    logger.warn(
      "Waited {waited}s and some repositories never appeared. Backrest indexes serially, so one repository it cannot read holds up everything queued behind it; a repository reported unindexed here may simply not have run yet.",
      { waited: fleet.waitedSeconds },
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `@sntxrr/backrest/instance` model: a Backrest server, its repositories,
 * and how fresh each one's snapshots are.
 *
 * `sync` reads. `reindex` triggers Backrest's own `TASK_INDEX_SNAPSHOTS` and
 * then reads; it never creates, forgets or prunes a snapshot, so it is safe to
 * schedule against a live server.
 */
export const model = {
  type: "@sntxrr/backrest/instance",
  description:
    "Keep a Backrest server's snapshot index current for repositories it does not back up itself, and report how fresh each one is. Never writes to a restic repository.",
  version: "2026.09.05.2",
  // No globalArguments changed meaning between 2026.09.05.1 and .2, so there is
  // nothing to migrate — but the entry still has to exist, or instances stay
  // pinned to the old typeVersion and never pick up the corrected wait.
  upgrades: [
    {
      toVersion: "2026.09.05.2",
      description:
        "reindex now waits for the picture to stop changing rather than only for every repository to be present. On a healthy fleet every repository already has snapshots, so the old condition was satisfied immediately and the run reported the state from BEFORE its own trigger — a backup that had stopped running would not have been noticed until the following day. Nothing to migrate; runs simply take one or two poll intervals instead of returning instantly.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    fleet: {
      description:
        "Per-repository snapshot freshness as this Backrest instance sees it, with repositories it could not read at all counted separately from those whose backups have stopped advancing.",
      schema: FleetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    sync: {
      description:
        "Report each repository's newest indexed snapshot without triggering anything. Read-only. Reflects the last time Backrest indexed, which for a repository it does not back up may be never.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;

        const repoIds = await listRepos(globalArgs);
        const observed = await readSnapshots(globalArgs);

        const statuses = assess(
          repoIds,
          observed,
          new Map(),
          Date.now(),
          globalArgs.maxSnapshotAgeHours,
        );
        const fleet = summarise(
          globalArgs.apiUrl,
          globalArgs.maxSnapshotAgeHours,
          statuses,
          false,
          0,
          statuses.every((s) => s.status !== "unindexed"),
        );

        report(logger, fleet);
        await context.writeResource("fleet", "current", fleet);
        return fleet;
      },
    },

    reindex: {
      description:
        "Ask Backrest to index every configured repository, wait for them to appear, then report per-repository freshness. This is the method to schedule. Triggers Backrest's own TASK_INDEX_SNAPSHOTS, which reads a repository and never modifies it.",
      arguments: z.object({
        repos: z.array(z.string()).default([]).describe(
          "Limit to these repository ids. Empty means every configured repository, minus `excludeRepos`.",
        ),
      }),
      execute: async (args: { repos: string[] }, context: Context) => {
        const { globalArgs, logger } = context;

        const configured = await listRepos(globalArgs);
        const requested = args.repos.length > 0 ? args.repos : configured;

        const unknown = requested.filter((id) => !configured.includes(id));
        if (unknown.length > 0) {
          throw new Error(
            `Not configured on this Backrest instance: ${
              unknown.join(", ")
            }. Configured: ${configured.join(", ")}`,
          );
        }

        // Baseline first, so "did this repository move" is answerable rather
        // than inferred from whether it has any snapshots at all.
        const before = await readSnapshots(globalArgs);
        const baseline = new Map(
          [...before].map(([repoId, entry]) => [repoId, entry.latestMs]),
        );

        logger.info("Triggering a snapshot index for {count} repositories", {
          count: requested.length,
        });

        for (const repoId of requested) {
          await call(globalArgs, "DoRepoTask", {
            repoId,
            task: "TASK_INDEX_SNAPSHOTS",
          });
        }

        // DoRepoTask enqueues and returns; it does not wait, so the reading
        // must not be taken before the tasks land. Poll until the picture stops
        // changing: every requested repository seen at least once AND no
        // repository's newest snapshot advanced since the previous poll.
        //
        // The "stops changing" half is load-bearing. Waiting only for presence
        // would exit immediately on a healthy fleet, where every repository
        // already has snapshots from previous runs — reporting the state from
        // BEFORE the trigger, so a backup that stopped running would not be
        // noticed until the following day. At least one poll always happens.
        //
        // A repository Backrest cannot read never becomes present, so it holds
        // the loop to the deadline. That is the condition most worth being sure
        // about, and the deadline is what bounds it.
        const startedAt = Date.now();
        const deadline = startedAt + globalArgs.settleTimeoutSeconds * 1000;
        let observed = before;
        let allObserved = false;

        while (Date.now() < deadline) {
          await sleep(globalArgs.pollIntervalSeconds * 1000);
          const previous = observed;
          observed = await readSnapshots(globalArgs);

          const state = isSettled(requested, previous, observed);
          allObserved = state.allObserved;
          if (state.settled) break;
        }

        const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
        const statuses = assess(
          requested,
          observed,
          baseline,
          Date.now(),
          globalArgs.maxSnapshotAgeHours,
        );
        const fleet = summarise(
          globalArgs.apiUrl,
          globalArgs.maxSnapshotAgeHours,
          statuses,
          true,
          waitedSeconds,
          allObserved,
        );

        report(logger, fleet);
        await context.writeResource("fleet", "current", fleet);
        return fleet;
      },
    },
  },
};

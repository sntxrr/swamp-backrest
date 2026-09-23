import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assess,
  authorization,
  endpoint,
  groupSnapshots,
  isSettled,
  plaintextCredentialWarning,
  summarise,
} from "./backrest_instance.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function op(repoId: string, iso: string, asNumber = false) {
  const ms = Date.parse(iso);
  return {
    repoId,
    operationIndexSnapshot: {
      snapshot: { unixTimeMs: asNumber ? ms : String(ms) },
    },
  };
}

Deno.test("endpoint joins without doubling the slash", () => {
  assertEquals(
    endpoint("http://host:9898", "GetConfig"),
    "http://host:9898/v1.Backrest/GetConfig",
  );
  assertEquals(
    endpoint("http://host:9898/", "GetConfig"),
    "http://host:9898/v1.Backrest/GetConfig",
  );
  assertEquals(
    endpoint("http://host:9898///", "DoRepoTask"),
    "http://host:9898/v1.Backrest/DoRepoTask",
  );
});

Deno.test("groupSnapshots keys on each operation's own repoId", () => {
  // The whole point: the server hands back the entire log regardless of the
  // selector, so grouping must come from the operations themselves.
  const grouped = groupSnapshots([
    op("heron", "2026-09-05T04:00:00Z"),
    op("heron", "2026-09-04T04:00:00Z"),
    op("mallard", "2026-09-05T07:00:00Z"),
  ]);

  assertEquals(grouped.size, 2);
  assertEquals(grouped.get("heron")?.count, 2);
  assertEquals(
    grouped.get("heron")?.latestMs,
    Date.parse("2026-09-05T04:00:00Z"),
  );
  assertEquals(grouped.get("mallard")?.count, 1);
});

Deno.test("groupSnapshots keeps the newest regardless of arrival order", () => {
  const grouped = groupSnapshots([
    op("heron", "2026-09-01T04:00:00Z"),
    op("heron", "2026-09-05T04:00:00Z"),
    op("heron", "2026-09-03T04:00:00Z"),
  ]);
  assertEquals(
    grouped.get("heron")?.latestMs,
    Date.parse("2026-09-05T04:00:00Z"),
  );
});

Deno.test("groupSnapshots accepts numeric as well as string timestamps", () => {
  const grouped = groupSnapshots([op("heron", "2026-09-05T04:00:00Z", true)]);
  assertEquals(
    grouped.get("heron")?.latestMs,
    Date.parse("2026-09-05T04:00:00Z"),
  );
});

Deno.test("groupSnapshots ignores non-snapshot operations", () => {
  const grouped = groupSnapshots([
    { repoId: "heron", operationBackup: { status: "STATUS_SUCCESS" } } as never,
    op("heron", "2026-09-05T04:00:00Z"),
  ]);
  assertEquals(grouped.get("heron")?.count, 1);
});

Deno.test("groupSnapshots discards unusable rows rather than counting them", () => {
  const grouped = groupSnapshots([
    { operationIndexSnapshot: { snapshot: { unixTimeMs: "1" } } } as never,
    { repoId: "", operationIndexSnapshot: { snapshot: { unixTimeMs: "1" } } },
    { repoId: "heron", operationIndexSnapshot: { snapshot: {} } },
    { repoId: "heron", operationIndexSnapshot: {} },
    {
      repoId: "heron",
      operationIndexSnapshot: { snapshot: { unixTimeMs: "not-a-number" } },
    },
    {
      repoId: "heron",
      operationIndexSnapshot: { snapshot: { unixTimeMs: 0 } },
    },
    {
      repoId: "heron",
      operationIndexSnapshot: { snapshot: { unixTimeMs: -5 } },
    },
  ]);
  // A zero or negative epoch would otherwise read as 1970 and look catastrophic.
  assertEquals(grouped.size, 0);
});

Deno.test("assess separates never-read from stopped-advancing", () => {
  const observed = groupSnapshots([
    op("heron", "2026-09-05T04:00:00Z"), // 8h old  -> ok
    op("mallard", "2026-08-30T04:00:00Z"), // 152h old -> stale
  ]);

  const statuses = assess(
    ["heron", "mallard", "kestrel"],
    observed,
    new Map(),
    NOW,
    48,
  );

  assertEquals(statuses.map((s) => s.status), ["ok", "stale", "unindexed"]);
  assertEquals(statuses[0].ageHours, 8);
  assertEquals(statuses[2].snapshotCount, 0);
  assertEquals(statuses[2].latestSnapshotAt, null);
  assertEquals(statuses[2].ageHours, null);
});

Deno.test("assess treats the freshness limit as exclusive at the boundary", () => {
  const observed = groupSnapshots([
    op("heron", new Date(NOW - 48 * HOUR).toISOString()),
  ]);
  assertEquals(assess(["heron"], observed, new Map(), NOW, 48)[0].status, "ok");

  const older = groupSnapshots([
    op("heron", new Date(NOW - 48 * HOUR - 60_000).toISOString()),
  ]);
  assertEquals(
    assess(["heron"], older, new Map(), NOW, 48)[0].status,
    "stale",
  );
});

Deno.test("assess reports movement only when the newest snapshot advanced", () => {
  const observed = groupSnapshots([op("heron", "2026-09-05T04:00:00Z")]);

  // Unchanged since the baseline: re-indexing an idle repository is a no-op,
  // which must not be mistaken for fresh activity.
  const unchanged = assess(
    ["heron"],
    observed,
    new Map([["heron", Date.parse("2026-09-05T04:00:00Z")]]),
    NOW,
    48,
  );
  assertEquals(unchanged[0].movedThisRun, false);

  const advanced = assess(
    ["heron"],
    observed,
    new Map([["heron", Date.parse("2026-09-04T04:00:00Z")]]),
    NOW,
    48,
  );
  assertEquals(advanced[0].movedThisRun, true);

  // Absent from the baseline entirely means it appeared during this run.
  const appeared = assess(["heron"], observed, new Map(), NOW, 48);
  assertEquals(appeared[0].movedThisRun, true);
});

Deno.test("summarise counts each failure class separately", () => {
  const statuses = assess(
    ["heron", "mallard", "kestrel", "godwit"],
    groupSnapshots([
      op("heron", "2026-09-05T04:00:00Z"),
      op("mallard", "2026-09-05T05:00:00Z"),
      op("kestrel", "2026-08-01T04:00:00Z"),
    ]),
    new Map(),
    NOW,
    48,
  );

  const fleet = summarise("http://host:9898", 48, statuses, true, 42, false);

  assertEquals(fleet.total, 4);
  assertEquals(fleet.ok, 2);
  assertEquals(fleet.stale, 1);
  assertEquals(fleet.unindexed, 1);
  assertEquals(fleet.problemRepos, ["godwit", "kestrel"]);
  assertEquals(fleet.reindexed, true);
  assertEquals(fleet.waitedSeconds, 42);
  assertEquals(fleet.allObserved, false);
  assertEquals(fleet.maxSnapshotAgeHours, 48);
});

Deno.test("summarise on a wholly healthy fleet reports no problems", () => {
  const statuses = assess(
    ["heron", "mallard"],
    groupSnapshots([
      op("heron", "2026-09-05T04:00:00Z"),
      op("mallard", "2026-09-05T05:00:00Z"),
    ]),
    new Map(),
    NOW,
    48,
  );
  const fleet = summarise("http://host:9898", 48, statuses, true, 12, true);

  assertEquals(fleet.ok, 2);
  assertEquals(fleet.problemRepos, []);
  assertEquals(fleet.allObserved, true);
});

Deno.test("an empty fleet does not read as a healthy fleet", () => {
  // Guards the assert-the-positive trap: ok===stale===0 must not be mistaken
  // for success by a consumer, so total is what a caller has to check.
  const fleet = summarise("http://host:9898", 48, [], false, 0, true);
  assertEquals(fleet.total, 0);
  assertEquals(fleet.ok, 0);
  assertEquals(fleet.problemRepos, []);
});

Deno.test("assess preserves the order it was asked for", () => {
  const observed = groupSnapshots([op("mallard", "2026-09-05T04:00:00Z")]);
  const statuses = assess(
    ["kestrel", "mallard", "heron"],
    observed,
    new Map(),
    NOW,
    48,
  );
  assertEquals(statuses.map((s) => s.repoId), ["kestrel", "mallard", "heron"]);
});

Deno.test("endpoint rejects nothing it is given — callers pass fixed names", () => {
  // Documents that method names are internal constants, never user input.
  assertThrows(() => {
    // deno-lint-ignore no-explicit-any
    (endpoint as any)(undefined, "GetConfig");
  });
});

Deno.test("isSettled requires BOTH all-seen and nothing-advancing", () => {
  const a = groupSnapshots([op("heron", "2026-09-05T04:00:00Z")]);
  const b = groupSnapshots([op("heron", "2026-09-05T05:00:00Z")]);

  // Advanced since the previous poll -> not settled, even though all are seen.
  const moving = isSettled(["heron"], a, b);
  assertEquals(moving.allObserved, true);
  assertEquals(moving.advanced, true);
  assertEquals(moving.settled, false);

  // Same picture twice -> settled.
  const still = isSettled(["heron"], b, b);
  assertEquals(still.advanced, false);
  assertEquals(still.settled, true);
});

Deno.test("isSettled is false while any repository is still unseen", () => {
  const seen = groupSnapshots([op("heron", "2026-09-05T04:00:00Z")]);
  const state = isSettled(["heron", "mallard"], seen, seen);
  assertEquals(state.allObserved, false);
  assertEquals(state.settled, false);
});

Deno.test("isSettled counts a repository appearing for the first time as movement", () => {
  // Guards the regression this function exists for: on a healthy fleet every
  // repository is already present, so presence alone would declare victory
  // before the freshly triggered index tasks had landed, and the run would
  // report the state from BEFORE its own trigger.
  const before = groupSnapshots([]);
  const after = groupSnapshots([op("heron", "2026-09-05T04:00:00Z")]);
  const state = isSettled(["heron"], before, after);
  assertEquals(state.allObserved, true);
  assertEquals(state.advanced, true);
  assertEquals(state.settled, false);
});

// Decode the way Go's r.BasicAuth() does: base64 → bytes → split on the FIRST
// colon, so a password containing ':' survives.
function decodeBasic(header: string): [string, string] {
  const bytes = Uint8Array.from(
    atob(header.replace(/^Basic /, "")),
    (c) => c.charCodeAt(0),
  );
  const text = new TextDecoder().decode(bytes);
  const i = text.indexOf(":");
  return [text.slice(0, i), text.slice(i + 1)];
}

Deno.test("authorization sends nothing when no credential is configured", () => {
  assertEquals(authorization({}), undefined);
  assertEquals(authorization({ username: "", password: "" }), undefined);
});

Deno.test("authorization sends Basic for username and password", () => {
  const header = authorization({ username: "automation", password: "s3cret" });
  assertEquals(header, "Basic YXV0b21hdGlvbjpzM2NyZXQ=");
});

Deno.test("authorization round-trips colons and non-ASCII in the password", () => {
  const password = "p:ä:ß✓";
  const header = authorization({ username: "automation", password })!;
  assertEquals(decodeBasic(header), ["automation", password]);
});

Deno.test("authorization keeps sending Bearer for apiKey", () => {
  assertEquals(authorization({ apiKey: "jwt" }), "Bearer jwt");
});

Deno.test("authorization refuses half a Basic credential", () => {
  assertThrows(
    () => authorization({ username: "automation" }),
    Error,
    "password is empty",
  );
  assertThrows(
    () => authorization({ password: "s3cret" }),
    Error,
    "username is empty",
  );
});

Deno.test("authorization refuses Basic and apiKey together", () => {
  assertThrows(
    () => authorization({ apiKey: "jwt", username: "a", password: "b" }),
    Error,
    "not both",
  );
});

Deno.test("authorization errors never echo the password", () => {
  try {
    authorization({ password: "do-not-print-me" });
  } catch (e) {
    assertEquals(String(e).includes("do-not-print-me"), false);
  }
});

const BASIC = { username: "automation", password: "s3cret" };

Deno.test("plaintext warning fires for credentials over http to another host", () => {
  const w = plaintextCredentialWarning({
    apiUrl: "http://backrest.internal:9898",
    ...BASIC,
    allowPlaintextCredentials: false,
  });
  assertEquals(typeof w, "string");
  assertEquals(
    w!.includes("Basic credentials to backrest.internal:9898"),
    true,
  );
  assertEquals(w!.includes("s3cret"), false);
  assertEquals(w!.includes("automation"), false);
});

Deno.test("plaintext warning names Bearer for apiKey", () => {
  const w = plaintextCredentialWarning({
    apiUrl: "http://10.0.0.5:9898",
    apiKey: "jwt",
    allowPlaintextCredentials: false,
  });
  assertEquals(w!.includes("Bearer credentials"), true);
  assertEquals(w!.includes("jwt"), false);
});

Deno.test("plaintext warning is silent for https", () => {
  assertEquals(
    plaintextCredentialWarning({
      apiUrl: "https://backrest.internal",
      ...BASIC,
      allowPlaintextCredentials: false,
    }),
    undefined,
  );
});

Deno.test("plaintext warning is silent for every loopback form", () => {
  for (
    const apiUrl of [
      "http://localhost:9898",
      "http://LOCALHOST:9898",
      "http://backrest.localhost:9898",
      "http://127.0.0.1:9898",
      "http://127.8.9.10:9898",
      "http://[::1]:9898",
    ]
  ) {
    assertEquals(
      plaintextCredentialWarning({
        apiUrl,
        ...BASIC,
        allowPlaintextCredentials: false,
      }),
      undefined,
      apiUrl,
    );
  }
});

Deno.test("plaintext warning does not mistake look-alike hosts for loopback", () => {
  for (
    const apiUrl of [
      "http://127.0.0.1.example.com:9898",
      "http://localhost.example.com:9898",
      "http://[::2]:9898",
    ]
  ) {
    assertEquals(
      typeof plaintextCredentialWarning({
        apiUrl,
        ...BASIC,
        allowPlaintextCredentials: false,
      }),
      "string",
      apiUrl,
    );
  }
});

Deno.test("plaintext warning is silent without a credential", () => {
  assertEquals(
    plaintextCredentialWarning({
      apiUrl: "http://backrest.internal:9898",
      allowPlaintextCredentials: false,
    }),
    undefined,
  );
});

Deno.test("allowPlaintextCredentials silences the warning", () => {
  assertEquals(
    plaintextCredentialWarning({
      apiUrl: "http://backrest.internal:9898",
      ...BASIC,
      allowPlaintextCredentials: true,
    }),
    undefined,
  );
});

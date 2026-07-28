# Download Gate Worker

A JFrog Worker that subscribes to the `BEFORE_DOWNLOAD` lifecycle event. On each download request, the Worker reads the artifact's `hiddenlayer.status` property and returns a proceed, stop, or warn directive to Artifactory. It is the enforcement point of the scanning pipeline—without this Worker, scan results have no effect on artifact access.

## Prerequisites

JFrog Workers require an Enterprise X or Enterprise+ license. Enforced download blocking (the stop directive actually preventing the download) additionally requires JFrog Advanced Security (JAS) or Curation entitlements.

Without JAS or Curation, the Worker still deploys and runs, but JFrog does not enforce stop directives: downloads proceed and the platform logs a warning instead. This is JFrog platform behavior, not a Worker configuration. The Worker needs no changes between the two situations—it always returns the verdict its configuration dictates.

Customers wanting enforced blocking should confirm their entitlements with JFrog before relying on this Worker to prevent downloads.

## Configuration

All settings are constants in the configuration block at the top of `worker.ts`. Repository targeting lives in `manifest.json`.

| Setting | Allowed Values | Default | Governs |
|---------|---------------|---------|---------|
| `PENDING_VERDICT` | `STOP`, `WARN` | `STOP` | Artifacts whose scan is in progress. |
| `FAILED_VERDICT` | `STOP`, `WARN` | `STOP` | Artifacts whose scan failed, and any unrecognized status values. |
| `MISSING_VERDICT` | `STOP`, `WARN`, `PROCEED` | `STOP` | Artifacts with no `hiddenlayer.status` property, and Worker-internal errors (read failures, timeouts). |
| `perCallWaitBoundMs` | milliseconds | `2,000` | How long the Worker waits on either JFrog call before treating it as failed. |

All three verdict defaults fail closed—an artifact is not downloadable until a scan affirmatively clears it—where stop directives are enforced (see Prerequisites). `SAFE` and `UNSAFE` verdicts are fixed and not configurable: `SAFE` always proceeds, `UNSAFE` always stops.

### Consequences of `MISSING_VERDICT = PROCEED`

With this setting, the first download of an untagged artifact proceeds while the Worker simultaneously tags it `PENDING` for scanning. Subsequent downloads follow `PENDING_VERDICT` (default `STOP`) until the scan completes. This means one unscanned download is permitted per artifact. The setting exists for deployments where download availability outweighs fail-closed blocking on unscanned content.

### Per-Call Wait Bound

This Worker sits inside a user's download request. An unbounded property read does not merely delay a background job; it holds the download open until the platform terminates the execution. The wait bound caps the delay this Worker can add to a download while making a slow platform fail closed: a timed-out read follows the same `MISSING_VERDICT` path as any other read failure. A timed-out backfill write leaves the verdict unchanged.

## Repository Targeting

The Worker applies to exactly the repositories listed in `filterCriteria.artifactFilterCriteria.repoKeys` in `manifest.json`. The Worker contains no repository list of its own: if the event fired, the artifact is in scope.

The repository list must cover the same repositories as the Scan Trigger and Result Poller Workers. A mismatch silently breaks the pipeline:

- A repository here but not in the Scan Trigger: downloads are gated but no scans are submitted. Artifacts sit blocked (or warned) indefinitely unless `MISSING_VERDICT = PROCEED` is set.
- A repository in the Scan Trigger but not here: scans complete but no download enforcement occurs.

Only **local repositories** should be targeted. The signed-URL mechanism used by the Scan Trigger assumes locally stored content. Targeting remote or virtual repositories would tag proxied artifacts that have no locally stored content, blocking them behind scans the pipeline cannot perform. Such artifacts would sit blocked indefinitely.

## Backfill Behavior

Artifacts uploaded before the integration was installed will never receive a status from the Scan Trigger Worker, because `AFTER_CREATE` only fires for new uploads. The Download Gate closes this gap: when a property read succeeds and shows no `hiddenlayer.status` property at all, the Worker writes two properties to the artifact in one atomic call before returning its verdict:

- `hiddenlayer.status` = `PENDING`
- `hiddenlayer.scan_requested_at` = current time (ISO 8601 UTC)

It deliberately does not write `hiddenlayer.scan_id`. The Result Poller treats a `PENDING` artifact with no `scan_id` whose `scan_requested_at` is older than its staleness threshold as a scan that needs (re-)triggering. Tagged artifacts are picked up and scanned automatically after that threshold elapses—on the order of tens of minutes, not seconds.

The current request's verdict is still `MISSING_VERDICT`. Tagging changes what future requests see, not the present one. If the backfill write fails, the Worker logs the failure and still returns `MISSING_VERDICT`. The next download attempt will try to tag again.

On a read error (network failure, 5xx, timeout), no tagging occurs. The Worker could not see the properties, so writing `PENDING` could overwrite a real `SAFE` or `UNSAFE` status.

## Decision Table

| Condition | Verdict | Side Effect |
|-----------|---------|-------------|
| `hiddenlayer.status` = `SAFE` | PROCEED | none |
| `hiddenlayer.status` = `UNSAFE` | STOP | none |
| `hiddenlayer.status` = `PENDING` | `PENDING_VERDICT` | none |
| `hiddenlayer.status` = `FAILED` | `FAILED_VERDICT` | none |
| Unrecognized value, empty, or multi-valued | `FAILED_VERDICT` | none |
| No `hiddenlayer.status` property | `MISSING_VERDICT` | Tags artifact `PENDING` for backfill |
| Property read fails or times out | `MISSING_VERDICT` | none |

Status comparison is exact and case-sensitive: only the literal string `SAFE` produces PROCEED.

## Verification Status

The unit test suite validates the Worker's decision logic—the allowlist stance, case sensitivity, every verdict path, the backfill tag, and the failed-read-no-write rule—against a mocked `PlatformContext`. It cannot validate that the event payload is read or the response shaped as the live platform expects.

The property endpoints and error model (including the 404-means-no-properties behavior and the top-level status field on errors) are live-verified against a tenant. The `BEFORE_DOWNLOAD` event payload fields and the response object's `status`/`message` handling are taken from JFrog's published sample project and server-generated types. Confirming those two on first deployment is a required follow-up.

## Permission Hygiene

The gate trusts `hiddenlayer.status` at face value. Anyone with Annotate permission on a monitored repository can set `hiddenlayer.status = SAFE` and bypass the gate entirely. Customers must restrict Annotate on monitored repositories to administrators and the integration's service identity. This is a documented, accepted risk of the property-based integration design.

## Deployment

### JFrog CLI

From the directory containing `worker.ts` and `manifest.json`:

```bash
cd workers/download-gate
jf worker deploy
```

The Worker deploys disabled by default (`"enabled": false`); enable it after verifying the configuration and confirming that the Scan Trigger and Result Poller Workers are deployed and targeting the same repositories.

### Platform UI

1. Navigate to Administration → Workers in the JFrog Platform UI.
2. Create a new Worker with action type `BEFORE_DOWNLOAD`.
3. Paste the contents of `worker.ts` into the code editor.
4. Configure the repository targeting under Filter Criteria (local repositories only).
5. Test the Worker using the platform's test execution feature.
6. Enable the Worker.

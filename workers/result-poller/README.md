# Result Poller Worker

A scheduled JFrog Worker that resolves asynchronous HiddenLayer scans. It runs every 5 minutes, finds artifacts whose scans are unresolved or have failed, checks scan results against the HiddenLayer API, and records outcomes as artifact properties. It is the bridge between the Scan Trigger Worker (which submits scans) and the Download Gate Worker (which reads verdicts at download time). Without this Worker, no artifact ever leaves `PENDING`.

## Prerequisites

JFrog Workers require an Enterprise X or Enterprise+ license. This Worker performs no download blocking and needs no security entitlements beyond the Workers feature itself.

## Configuration

All settings are constants in the configuration block at the top of `worker.ts`. Secrets and the cron schedule live in `manifest.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `monitoredRepositories` | `[]` | Repository list used in both AQL discovery queries. Must match the repositories the Scan Trigger and Download Gate Workers cover. See [Repository Alignment](#repository-alignment). |
| Cron schedule (manifest) | `*/5 * * * *` | Run interval. Five-field minutes-resolution expression; a six-field expression including seconds is rejected. |
| `concurrencyLimit` | `25` | Maximum artifacts being processed at any moment. Each artifact's own HTTP calls run sequentially within its slot. |
| `remainingTimeReserveMs` | `10,000` | New artifacts are admitted only while `getRemainingExecutionTime()` exceeds this value. Must comfortably exceed 4 × `perCallWaitBoundMs`—the defaults leave 10,000 ms of headroom against an 8,000 ms worst case (4 sequential calls at 2,000 ms each). Lowering the reserve below that product risks the platform killing the execution mid-write. |
| `perCallWaitBoundMs` | `2,000` | How long the Worker waits on any one JFrog HTTP call before abandoning it. The Worker stops *waiting* but cannot *cancel*—an abandoned request may keep running until the platform ends the execution. |
| `stalenessThresholdMs` | `1,800,000` (30 min) | Age of `scan_requested_at` beyond which a PENDING artifact with no scan ID is re-triggered. Within the threshold, the Scan Trigger Worker may still be mid-flight. |
| `retryCap` | `5` | Maximum `retry_count`. At the cap, artifacts are terminal FAILED and require manual remediation. |
| `signedUrlTtlSecs` | `14,400` (4 hr) | TTL on signed URLs minted for re-triggered scans. Each re-trigger mints a fresh URL, so scans that previously failed because a URL expired recover automatically. |
| `hlApiBaseUrl` | `https://api.hiddenlayer.ai` | HiddenLayer scanning API host. For EU tenants: `https://api.eu.hiddenlayer.ai`. |
| `hlAuthBaseUrl` | `https://auth.hiddenlayer.ai` | HiddenLayer OAuth token endpoint host. For EU tenants: `https://auth.eu.hiddenlayer.ai`. |

**The two HiddenLayer URLs must move together when switching regions.** Changing only one authenticates against one region while scanning in another. The token exchange may succeed while every scan call returns 401 or routes to the wrong environment.

## Secrets

The Worker authenticates to the HiddenLayer API using OAuth2 client credentials. Two secrets are declared in `manifest.json`:

- **`HL_CLIENT_ID`**—the HiddenLayer API client ID
- **`HL_CLIENT_SECRET`**—the HiddenLayer API client secret

These are supplied as encrypted Worker secrets at deploy time. The source contains only empty placeholders.

To obtain credentials, create an API client in the HiddenLayer console (Settings → API Clients) with permissions to submit scans and read scan results.

## Repository Alignment

The `monitoredRepositories` list must cover the same repositories as the Scan Trigger and Download Gate Workers. A mismatch silently breaks the pipeline:

- A repository in the Scan Trigger but not here: scans are submitted but never resolved. Artifacts stay `PENDING` indefinitely.
- A repository here but not in the Scan Trigger: this Worker has nothing to poll.
- A repository missing from the Download Gate: resolved artifacts are never checked at download time.

## Retry Behavior

When a scan cannot be resolved—the scan failed, was canceled, the scan ID is no longer recognized, or the report is ambiguous—the Worker marks the artifact `FAILED` with an exponential backoff schedule:

| Attempt | Backoff |
|---------|---------|
| 1st | 2 minutes |
| 2nd | 4 minutes |
| 3rd | 8 minutes |
| 4th | 16 minutes |
| 5th | 32 minutes |

After the 5th attempt, the artifact is **terminal FAILED**: it is never re-triggered again and requires manual remediation.

The retry cap is shared across both re-trigger paths (FAILED artifacts eligible for retry and stale PENDING artifacts without a scan ID). Both consume from the same `retry_count`.

**Operational notes:**

- **Duplicate scans.** If a scan submission succeeds but the subsequent recording write fails, the scan ID is lost. A later run re-triggers the artifact and submits a second scan. The orphaned scan completes unobserved and has no effect on artifact state. The retry cap bounds how many times this can recur.

- **Multiple model versions.** Each submission receives a fresh platform-generated version, so an artifact that retried several times shows several versions in the HiddenLayer console. This is cosmetic—the artifact's operative record is its JFrog properties.

## Manual Remediation

An artifact that is permanently stuck—terminal `FAILED`, or `PENDING` on a scan that never completes—can be recovered by deleting all `hiddenlayer.*` properties from the artifact. After deletion, the next download attempt (via the Download Gate's backfill tagging) or re-upload re-enters the artifact into the scanning pipeline.

Scans are expected to always reach a terminal state (`done`, `failed`, or `canceled`). The integration contains no automatic handling for a scan that remains `running` indefinitely; this procedure is the recovery path if that expectation is ever violated.

## Deployment

### JFrog CLI

From the directory containing `worker.ts` and `manifest.json`:

```bash
cd workers/result-poller
jf worker deploy
```

The CLI prompts for secret values if they are empty in `manifest.json`. The Worker deploys disabled by default (`"enabled": false`); enable it after verifying the configuration.

### Platform UI

1. Navigate to Administration → Workers in the JFrog Platform UI.
2. Create a new Worker with action type `SCHEDULED_EVENT`.
3. Paste the contents of `worker.ts` into the code editor.
4. Configure the schedule (`*/5 * * * *`, UTC).
5. Add the two secrets (`HL_CLIENT_ID`, `HL_CLIENT_SECRET`) with the appropriate values.
6. Test the Worker using the platform's test execution feature.
7. Enable the Worker.

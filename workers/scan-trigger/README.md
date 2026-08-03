# Scan Trigger Worker

A JFrog Worker that subscribes to the `AFTER_CREATE` lifecycle event. When an artifact is created in a monitored repository, the Worker resets any prior integration state, tags the artifact `PENDING`, generates a signed download URL, and submits a scan job to the HiddenLayer API. It is the entry point of the scanning pipeline—without this Worker, no artifact enters `PENDING` and no scan is submitted.

## Prerequisites

JFrog Workers require an Enterprise X or Enterprise+ license. The signed-URL API used for scan submissions may carry the same tier requirement. This Worker performs no download blocking and needs no security entitlements beyond the Workers feature itself and the ability to mint signed URLs.

## Configuration

All settings are constants in the configuration block at the top of `worker.ts`. Secrets and repository targeting live in `manifest.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| Repository targeting (manifest `filterCriteria`) | (none—must be configured) | Which repositories fire this Worker. Must be **local repositories** and must match the repository lists configured for the Result Poller and Download Gate Workers. See [Repository Targeting](#repository-targeting). |
| `signedUrlTtlSecs` | `14,400` (4 hr) | TTL on signed URLs minted for scan submissions. Must comfortably exceed expected scan-queue latency—an expired URL fails the scan and consumes a poller retry. Matches the Result Poller's default. |
| `perCallWaitBoundMs` | `2,000` | How long the Worker waits on any one HTTP call. JFrog calls are bounded by racing against a timer; HiddenLayer calls pass a `timeout` option directly. |
| `hlApiBaseUrl` | `https://api.hiddenlayer.ai` | HiddenLayer scanning API host. For EU tenants: `https://api.eu.hiddenlayer.ai`. |
| `hlAuthBaseUrl` | `https://auth.hiddenlayer.ai` | HiddenLayer OAuth token endpoint host. For EU tenants: `https://auth.eu.hiddenlayer.ai`. |

**The two HiddenLayer URLs must move together when switching regions.** Changing only one authenticates against one region while scanning in another. The token exchange may succeed while every scan call returns 401 or routes to the wrong environment.

## Secrets

The Worker authenticates to the HiddenLayer API using OAuth2 client credentials. Two secrets are declared in `manifest.json`:

- **`HL_CLIENT_ID`**—the HiddenLayer API client ID
- **`HL_CLIENT_SECRET`**—the HiddenLayer API client secret

To obtain credentials, create an API client in the HiddenLayer console (Settings → API Clients) with permissions to submit scans and read scan results.

Add the secrets to `manifest.json` before deploying:

```bash
jf worker add-secret HL_CLIENT_ID
jf worker add-secret HL_CLIENT_SECRET
```

Each command prompts for an encryption password and the secret value. Use the same encryption password for both secrets—the CLI uses it to decrypt them at deploy time. Alternatively, secrets can be entered directly through the Platform UI when creating the Worker (see [Deployment](#deployment)).

## Repository Targeting

The Worker applies to exactly the repositories listed in `filterCriteria.artifactFilterCriteria.repoKeys` in `manifest.json`. The Worker contains no repository list of its own: if the event fired, the artifact is in scope.

The repository list must cover the same repositories as the Result Poller and Download Gate Workers. A mismatch silently breaks the pipeline:

- A repository here but not in the Result Poller: scans are submitted but never resolved. Artifacts stay `PENDING` indefinitely.
- A repository in the Result Poller but not here: the poller has nothing to poll.
- A repository missing from the Download Gate: resolved artifacts are never checked at download time.

Only **local repositories** should be targeted. The signed-URL mechanism assumes locally stored content; remote-proxy and virtual repository support is out of scope.

## Scan-Everything Policy

Every artifact in a monitored repository is scanned. There is no file-name or MIME-type filtering: both are attacker-controlled and trivially spoofed (a malicious pickle named `README.md`, an executable declaring itself `text/plain`). The scanner determines file type from content. Repository selection is the cost-control knob—add only repositories that contain content worth scanning.

## Overwrite Behavior

Re-uploads to an existing path are treated as brand-new artifacts. The Worker runs the full sequence from scratch: all prior integration properties are cleared, the artifact re-enters `PENDING`, and a new scan is submitted. There is no branch that distinguishes a first upload from an overwrite.

Artifactory itself clears an artifact's properties on overwrite (verified for standard deploys to generic local repositories). This Worker's reset makes that guarantee independent of the delivery path—copies, moves, replications, checksum deploys, and package-type-specific flows were not tested, and the cost of being wrong is a false `SAFE` on attacker-supplied content. The reset is defense in depth.

**Transient serving window.** `AFTER_CREATE` fires after the content is already replaced, so there is a brief window—event-dispatch latency plus Worker execution time—during which the new content is downloadable before this Worker has tagged it. During that window, the artifact presents as unscanned (the overwrite having wiped its properties). Under the Download Gate's default `MISSING_VERDICT = STOP` setting, the gate refuses the download, so the risk is a brief download refusal rather than a false clean. Deployments that set `MISSING_VERDICT = PROCEED` re-open that window.

**Residual risk of a failed reset.** If the reset step fails (after one retry), the Worker aborts without tagging. The prior content's properties—possibly `SAFE`—remain on the new content until the failure is noticed in the platform's execution logs. `AFTER_CREATE` cannot block, so no fail-closed option exists at this step.

## Failure Recovery

Every failure path leaves the artifact in a state that some other part of the integration recovers:

| Failure | Artifact State | Recovery |
|---------|---------------|----------|
| Reset fails (after retry) | Prior properties survive | Manual: check execution logs, re-upload or clear properties |
| Tag write fails | No properties | Download Gate backfill tagging re-enters the artifact on its next download attempt |
| Signed URL, token exchange, or scan submission fails | `PENDING`, no `scan_id` | Result Poller re-triggers after the staleness threshold, bounded by the retry cap |
| Record write fails | `PENDING`, no `scan_id` | Same as above. The orphaned scan completes unobserved and affects nothing. |

The trigger never retries a submission. All retry machinery belongs to the Result Poller.

## Deployment

### JFrog CLI

From the directory containing `worker.ts` and `manifest.json`:

```bash
cd workers/scan-trigger
jf worker deploy
```

The CLI prompts for the secrets encryption password to decrypt the values added via `jf worker add-secret` (see [Secrets](#secrets)). The Worker deploys disabled by default (`"enabled": false`); enable it after verifying the configuration.

### Platform UI

1. Navigate to Administration → Workers in the JFrog Platform UI.
2. Create a new Worker with action type `AFTER_CREATE`.
3. Paste the contents of `worker.ts` into the code editor.
4. Configure the repository targeting under Filter Criteria (local repositories only).
5. Add the two secrets (`HL_CLIENT_ID`, `HL_CLIENT_SECRET`) with the appropriate values.
6. Test the Worker using the platform's test execution feature.
7. Enable the Worker.

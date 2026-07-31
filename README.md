# HiddenLayer Artifactory Workers

Three JFrog Workers that integrate HiddenLayer model scanning into JFrog Artifactory. Artifacts in monitored repositories are scanned automatically on upload, and scan verdicts are enforced at download time.

## Architecture

The integration is a pipeline of three independent Workers that communicate through `hiddenlayer.*` artifact properties:

1. **[Scan Trigger](workers/scan-trigger/)** (`AFTER_CREATE`) — When an artifact is uploaded to a monitored repository, this Worker resets any prior scan state, tags the artifact `PENDING`, and submits a scan job to the HiddenLayer API via a signed download URL.

2. **[Result Poller](workers/result-poller/)** (`SCHEDULED_EVENT`) — Runs on a cron schedule (default: every 5 minutes). Discovers `PENDING` and `FAILED` artifacts, checks their scan results against the HiddenLayer API, and writes the final verdict (`SAFE`, `UNSAFE`, or `FAILED`) back to artifact properties. Re-triggers scans for stale or failed submissions up to a configurable retry cap.

3. **[Download Gate](workers/download-gate/)** (`BEFORE_DOWNLOAD`) — On each download request, reads the artifact's `hiddenlayer.status` property and returns a proceed, stop, or warn directive to Artifactory. Pre-existing artifacts without a status are tagged `PENDING` for automatic backfill scanning.

The three Workers share no code and no state other than artifact properties. Each Worker's README contains its full configuration reference, deployment instructions, and behavioral documentation.

## Platform Limits

JFrog Workers run under strict resource constraints. Each execution is limited to **20 seconds of wall-clock time**, **1 second of CPU time**, and **64 MB of memory**. The Workers are designed to operate well within these bounds, but they shape the integration's architecture—scans are submitted asynchronously rather than computed inline, and the Result Poller processes artifacts in bounded batches across multiple runs rather than all at once.

HiddenLayer's Model Scanner imposes its own limits on scan size and throughput. These limits depend on your HiddenLayer plan and may affect how quickly large backlogs are processed. Consult your HiddenLayer account documentation for details.

## Prerequisites

- **JFrog Platform:** Enterprise X or Enterprise+ license with the Workers feature enabled.
- **Enforced download blocking:** Requires JFrog Advanced Security (JAS) or Curation entitlements. Without these, the Download Gate Worker still runs, but stop directives are logged as warnings rather than enforced. The Workers need no configuration change between the two situations.
- **HiddenLayer API credentials:** A client ID and secret from the HiddenLayer console (Settings → API Clients) with permissions to submit scans and read scan results. Required by the Scan Trigger and Result Poller Workers; the Download Gate Worker needs no credentials.

## Overriding a Blocked Download

If the Download Gate blocks an artifact you need to access—because a scan is still in progress, a scan failed, or you disagree with the verdict—you can override it by setting the artifact's `hiddenlayer.status` property directly.

Using the JFrog CLI:

```bash
jf rt set-props "my-repo/path/to/artifact" "hiddenlayer.status=SAFE"
```

Using the REST API:

```bash
curl -u admin:password -X PUT \
  "https://your-instance.jfrog.io/artifactory/api/storage/my-repo/path/to/artifact?properties=hiddenlayer.status=SAFE"
```

Or through the Artifactory UI: navigate to the artifact, open the Properties tab, and set `hiddenlayer.status` to `SAFE`.

The Download Gate trusts this property at face value—setting it to `SAFE` allows the download immediately. The next scan cycle will not overwrite a manually set status unless the artifact is re-uploaded (which resets all properties). Restrict Annotate permission on monitored repositories to administrators and the integration's service identity to prevent unauthorized overrides.

## Installation

### JFrog CLI

The Workers are deployed using the [JFrog CLI (`jf`)](https://docs.jfrog-applications.jfrog.io/jfrog-applications/jfrog-cli/install). Once installed, configure it to point at your Artifactory instance:

```bash
jf c add
```

Deploy each Worker from its directory:

```bash
cd workers/scan-trigger && jf worker deploy
cd workers/result-poller && jf worker deploy
cd workers/download-gate && jf worker deploy
```

The CLI prompts for secret values (HiddenLayer client ID and secret) on the Scan Trigger and Result Poller deployments. All three Workers deploy disabled by default; enable each after verifying its configuration.

### Platform UI

Workers can also be deployed through the JFrog Platform UI without the CLI. Navigate to Administration → Workers, create a new Worker with the appropriate action type, paste the contents of `worker.ts`, configure repository targeting and secrets, and enable. See each Worker's README for step-by-step instructions.

## Configuration

Each Worker's README documents its full configuration. The key settings to align across all three:

- **Repository targeting** — All three Workers must monitor the same set of local repositories, configured in each Worker's `manifest.json` under `filterCriteria.artifactFilterCriteria.repoKeys`. A mismatch silently breaks the pipeline: a repository in the Scan Trigger but not the Download Gate means scans complete but verdicts are never enforced.
- **HiddenLayer API endpoints** — The Scan Trigger and Result Poller each configure `hlApiBaseUrl` and `hlAuthBaseUrl`. Both must point to the same region (e.g., `api.hiddenlayer.ai` / `auth.hiddenlayer.ai` for US, or the `.eu.` equivalents).
- **Verdict defaults** — The Download Gate's three configurable verdicts (`PENDING_VERDICT`, `FAILED_VERDICT`, `MISSING_VERDICT`) all default to `STOP` (fail closed). Adjust only when the deployment's availability requirements outweigh fail-closed blocking on unscanned content.

## Development

This is an npm workspace monorepo. All dev dependencies are hoisted to the root.

```bash
# Install dependencies
npm install

# Run all tests (121 tests across 3 workers)
npm test --workspaces

# Lint
npx eslint workers/

# Format check
npx prettier --check "workers/**/*.ts"
```

Each Worker can also be tested individually:

```bash
npm test --workspace=workers/scan-trigger
npm test --workspace=workers/result-poller
npm test --workspace=workers/download-gate
```

## License

[Apache License 2.0](LICENSE)

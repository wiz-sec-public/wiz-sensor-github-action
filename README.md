# wiz-sensor-github-action

A GitHub Action that downloads and starts the Wiz Sensor to monitor other steps in the workflow.
Add it as the first step of a job so the sensor is up before any subsequent step runs.

The action takes a required `token` input with credentials. Get the token from the Wiz UI
and store it as a repository secret.

## Usage

```yaml
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: wiz-sec-public/wiz-sensor-github-action@v0.9.3
        with:
          token: ${{ secrets.WIZ_SENSOR_TOKEN }}
      # ... your build steps
```

The token must be a JSON object with exactly these fields:

```json
{
  "registry-username": "...",
  "registry-password": "...",
  "wiz-api-client-id": "...",
  "wiz-api-client-secret": "..."
}
```

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `token` | Yes | JSON token containing registry credentials and Wiz API client credentials. |
| `install-only` | No | Only pull and cache the Wiz Sensor image without starting it. Defaults to `false`. Useful for pre-warming custom GitHub runner images. |
| `generate-support-package` | No | Collect a Wiz Sensor support package after the workflow steps finish and upload it as a workflow artifact. Defaults to `false`. |

## Generating a support package

Set `generate-support-package: true` to help Wiz support diagnose sensor issues.
After the other steps in the job finish, the action's cleanup step downloads and
runs the official [`sensor_support_linux.sh`](https://downloads.wiz.io/sensor/sensor_support_linux.sh)
script (as root) while the sensor is still running, then uploads the resulting
`support_package_linux.tar.gz` as a workflow artifact named
`wiz-sensor-support-package.tar.gz` (suffixed with the job id when available).
Download it from the run summary's **Artifacts** section.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: wiz-sec-public/wiz-sensor-github-action@v0.9.3
        with:
          token: ${{ secrets.WIZ_SENSOR_TOKEN }}
          generate-support-package: true
      # ... your build steps
```

Collecting and uploading the support package never fails the job: any error is
reported as a warning. The upload uses the built-in Actions runtime token and
does not require any additional workflow `permissions`.

## Pre-warming custom runner images (`install-only`)

When you build a [custom image for GitHub-hosted larger runners](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/use-custom-images),
you can bake the Wiz Sensor image into the image so that it does not have to be
downloaded on every job. Run the action with `install-only: true` in your
image-generation (`snapshot`) workflow. In this mode the action pulls the sensor
image into the local Docker daemon and exits without starting the sensor. The
same `token` is used as for a normal run.

The Docker image is the only artifact worth caching ahead of time. The sensor
refreshes its detection content at runtime, so nothing else needs to be prepared
during image generation.

```yaml
jobs:
  build-image:
    runs-on: my-image-generation-runner
    snapshot: my-custom-image
    steps:
      - uses: wiz-sec-public/wiz-sensor-github-action@v0.9.3
        with:
          install-only: true
          token: ${{ secrets.WIZ_SENSOR_TOKEN }}
      # ... any other tools you want to pre-install
```

Then, in jobs that run on the custom image, use the action as usual. When the
sensor image is already cached locally, the action skips the registry login and
pull and starts the sensor directly from the cached image:

```yaml
jobs:
  build:
    runs-on: my-custom-runner
    steps:
      - uses: wiz-sec-public/wiz-sensor-github-action@v0.9.3
        with:
          token: ${{ secrets.WIZ_SENSOR_TOKEN }}
      # ... your build steps
```

## Required permissions

This action does not require additional GitHub API permissions. Use the minimum
permissions required by the rest of your workflow.

For example, if the following build steps only need to read repository contents:

```yaml
permissions:
  contents: read
```

Store the Wiz Sensor token as a GitHub secret and pass it only to this action. Do not expose
the token to workflows that run untrusted code, such as pull requests from forks.

## Self-hosted runners

This action does not start the sensor container on self-hosted runners. If a self-hosted
runner already has a Wiz Sensor process running, the action detects it and skips container
startup. Otherwise, the action emits a warning and skips.

For self-hosted runners, install and manage the Wiz Sensor on the runner host ahead of time.

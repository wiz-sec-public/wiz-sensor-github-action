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
      - uses: wiz-sec-public/wiz-sensor-github-action@v0.9
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

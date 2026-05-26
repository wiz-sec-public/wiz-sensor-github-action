const fs = require("fs");
const { spawn } = require("child_process");

const STARTED_STATE_KEY = "WIZ_SENSOR_STARTED";
const CONTAINER_ID_STATE_KEY = "WIZ_SENSOR_CONTAINER_ID";
const DEBUG_LOGS_STATE_KEY = "WIZ_SENSOR_DEBUG_LOGS";
const DEFAULT_SENSOR_REGISTRY_URL = "wizio.azurecr.io";
const DEFAULT_SENSOR_IMAGE_NAME = "sensor";
const DEFAULT_SENSOR_CONTAINER_NAME = "wiz-sensor";
const ACTION_VERSION = "0.91";

let debugLogsEnabled = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function debugLog(message) {
  if (debugLogsEnabled) {
    log(`[debug] ${message}`);
  }
}

function parseBooleanInput(value) {
  const normalized = String(value).trim().toLowerCase();

  if (normalized !== "true" && normalized !== "false") {
    throw new Error(`Invalid boolean value: ${value} (expected "true" or "false")`);
  }

  return normalized === "true";
}

function getRawInput(name) {
  const githubEnvName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const compatEnvName = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  return process.env[githubEnvName] || process.env[compatEnvName] || "";
}

function getInput(name, defaultValue = "") {
  return getRawInput(name) || defaultValue;
}

function getTrimmedInput(name, defaultValue = "") {
  const value = getInput(name, defaultValue).trim();

  if (!value) {
    throw new Error(`Input ${name} must not be empty`);
  }

  return value;
}

function isLinuxRunner() {
  return process.env.RUNNER_OS === "Linux";
}

function isSelfHostedRunner() {
  return process.env.RUNNER_ENVIRONMENT === "self-hosted";
}

function emitWarning(message) {
  console.log(`::warning::${message}`);
}

function emitNotice(message) {
  console.log(`::notice::${message}`);
}

function saveState(name, value) {
  if (!process.env.GITHUB_STATE) {
    return;
  }

  fs.appendFileSync(process.env.GITHUB_STATE, `${name}=${value}\n`, "utf8");
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function elapsedSeconds(startMs) {
  return ((Date.now() - startMs) / 1000).toFixed(1);
}

async function runCommand(command, args, options = {}) {
  const { allowFailure = false, input } = options;

  const commandLine = formatCommand(command, args);
  debugLog(`Running command: ${commandLine}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const result = { code, stdout, stderr };

      debugLog(
        `Command finished: ${commandLine}\n  exit code: ${code}\n  stdout: ${stdout}\n  stderr: ${stderr}`,
      );

      if (code === 0 || allowFailure) {
        resolve(result);
        return;
      }

      reject(new Error(`Command failed with exit code ${code}: ${commandLine}`));
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }

    child.stdin.end();
  });
}

async function ensureDockerAvailable() {
  await runCommand("docker", ["--version"]);
  await runCommand("docker", ["ps"]);
}

function requireTokenString(value, keyName) {
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`token field ${keyName} must be a string`);
}

function decodeTokenPayload(token) {
  let parsed;

  try {
    parsed = JSON.parse(token);
  } catch (error) {
    throw new Error(`Failed to parse token: ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("token must be a JSON object");
  }

  return parsed;
}

function parseExtraEnv(value) {
  if (!value) {
    return [];
  }

  const entries = String(value)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    if (!/^[^=\s]+=/.test(entry)) {
      throw new Error(`input extra-env entries must be in "KEY=VALUE" format (got ${JSON.stringify(entry)})`);
    }
  }

  return entries;
}

function getInputs() {
  const TOKEN_INPUT_NAME = "token";
  const REQUIRED_TOKEN_FIELDS = [
    ["registry-username", "registryUsername"],
    ["registry-password", "registryPassword"],
    ["wiz-api-client-id", "wizApiClientId"],
    ["wiz-api-client-secret", "wizApiClientSecret"],
  ];

  const token = getRawInput(TOKEN_INPUT_NAME);

  if (!token) {
    throw new Error(`Missing required input: ${TOKEN_INPUT_NAME}`);
  }

  const payload = decodeTokenPayload(token);
  const resolved = {};
  const allowedTokenFields = new Set(REQUIRED_TOKEN_FIELDS.map(([tokenKey]) => tokenKey));
  const unknownTokenFields = Object.keys(payload).filter((tokenKey) => !allowedTokenFields.has(tokenKey));

  if (unknownTokenFields.length > 0) {
    throw new Error(`Unexpected token field(s): ${unknownTokenFields.join(", ")}`);
  }

  for (const [tokenKey, outputName] of REQUIRED_TOKEN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, tokenKey)) {
      throw new Error(`Missing required token field: ${tokenKey}`);
    }

    const value = requireTokenString(payload[tokenKey], tokenKey);

    if (!value) {
      throw new Error(`Missing required token field: ${tokenKey}`);
    }

    resolved[outputName] = value;
  }

  resolved.tag = getTrimmedInput("tag", "github_runner_private_preview");
  resolved.backendEnv = getTrimmedInput("backend-env", "prod");
  resolved.waitForReady = parseBooleanInput(getInput("wait-for-ready", "true"));
  resolved.debugLogs = parseBooleanInput(getInput("debug-logs", "false"));
  resolved.extraEnv = parseExtraEnv(getRawInput("extra-env"));
  resolved.sensorRegistryUrl = getTrimmedInput("sensor-registry-url", DEFAULT_SENSOR_REGISTRY_URL);
  resolved.sensorImageName = getTrimmedInput("sensor-image-name", DEFAULT_SENSOR_IMAGE_NAME);
  resolved.sensorContainerName = getTrimmedInput("sensor-container-name", DEFAULT_SENSOR_CONTAINER_NAME);

  return resolved;
}

async function hasInstalledSelfHostedSensor() {
  let result;
  try {
    result = await runCommand("ps", ["-eo", "comm=,args="], {
      allowFailure: true,
    });
  } catch (error) {
    return false;
  }

  if (result.code !== 0) {
    return false;
  }

  return result.stdout.split(/\r?\n/).some((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return false;
    }

    const firstSpaceIndex = trimmedLine.indexOf(" ");
    const commandName = firstSpaceIndex === -1 ? trimmedLine : trimmedLine.slice(0, firstSpaceIndex);
    const commandLine = firstSpaceIndex === -1 ? "" : trimmedLine.slice(firstSpaceIndex + 1);

    return commandName === "wiz-sensor" && commandLine.includes("--run-engine");
  });
}

function buildImageReference(inputs) {
  return `${inputs.sensorRegistryUrl}/${inputs.sensorImageName}:${inputs.tag}`;
}

function collectPassthroughEnv() {
  const PASSTHROUGH_ENV_PREFIXES = ["GITHUB_", "RUNNER_"];
  const result = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    if (PASSTHROUGH_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      result[name] = value;
    }
  }

  debugLog(`Passthrough env vars: ${Object.keys(result).sort().join(", ") || "(none)"}`);

  return result;
}

function buildDockerRunArgs(fullImage, inputs) {
  const dockerEnv = {
    WIZ_HOST_STORE: "/wiz-sensor-store/",
    WIZ_TMP_STORE: "/wiz-sensor-store/tmp_store/",
    WIZ_RAMFS_STORE: "/tmp/",
    WIZ_LOG_FILE: "/wiz-sensor-store/sensor.log",
    WIZ_BACKEND_ENV: inputs.backendEnv,
    WIZ_API_CLIENT_ID: inputs.wizApiClientId,
    WIZ_API_CLIENT_SECRET: inputs.wizApiClientSecret,
    WIZ_SENSOR_TYPE: "container",
    WIZ_CONTAINER_RUNTIME: "docker",
    JSON: "true",
    STDOUT_LOG: "true",
    WIZ_DEPLOYMENT_INFO: "github_hosted_runner",
    WIZ_GITHUB_ACTION_VERSION: ACTION_VERSION,
    WIZ_CGROUP_LIMITS_AFTER_INIT: "true",
    ...collectPassthroughEnv(),
  };

  const args = [
    "run",
    "--privileged",
    "--ipc=host",
    "--pid=host",
    "--rm",
    "-d",
  ];

  for (const [name, value] of Object.entries(dockerEnv)) {
    args.push("--env", `${name}=${value}`);
  }

  for (const entry of inputs.extraEnv) {
    args.push("--env", entry);
  }

  args.push(
    "-v",
    "/opt/wiz/sensor-store:/wiz-sensor-store",
    "--mount",
    "type=tmpfs,destination=/tmp,tmpfs-size=100m",
    "--mount",
    "type=bind,source=/sys/kernel/debug,target=/sys/kernel/debug,readonly",
    "--name",
    inputs.sensorContainerName,
    fullImage,
  );

  return args;
}

async function waitForSensorReady(containerId) {
  const READY_CHECK_TIMEOUT_S = 120;
  const startMs = Date.now();
  log("Waiting for Wiz Sensor readiness.");
  const result = await runCommand(
    "docker",
    [
      "exec",
      containerId,
      "/usr/src/app/wiz-sensor",
      "wait-for-ready",
      "--timeout",
      String(READY_CHECK_TIMEOUT_S),
    ],
    { allowFailure: true },
  );

  if (result.code !== 0) {
    throw new Error(`Wiz Sensor failed to become ready within ${READY_CHECK_TIMEOUT_S} seconds`);
  }

  debugLog(`Wiz Sensor readiness completed after ${elapsedSeconds(startMs)}s.`);
  log("Wiz Sensor started successfully!");
}

async function runMain() {
  if (!isLinuxRunner()) {
    emitNotice(`Wiz Sensor action runs only on Linux runners. Skipping on ${process.env.RUNNER_OS || "unknown"}.`);
    return;
  }

  if (isSelfHostedRunner()) {
    if (await hasInstalledSelfHostedSensor()) {
      emitNotice("Detected an existing Wiz Sensor installation. Skipping container startup.");
      return;
    }

    emitWarning("Wiz Sensor action is supported only on GitHub-hosted runners. Skipping on self-hosted runner.");
    return;
  }

  const inputs = getInputs();
  debugLogsEnabled = inputs.debugLogs;

  const fullImage = buildImageReference(inputs);

  await ensureDockerAvailable();

  log(`Pulling Wiz Sensor image ${fullImage}`);
  const pullStartMs = Date.now();

  await runCommand(
    "docker",
    [
      "login",
      inputs.sensorRegistryUrl,
      "--username",
      inputs.registryUsername,
      "--password-stdin",
    ],
    {
      input: `${inputs.registryPassword}\n`,
    },
  );

  try {
    await runCommand("docker", ["pull", fullImage]);
  } finally {
    await runCommand("docker", ["logout", inputs.sensorRegistryUrl], {
      allowFailure: true,
    });
  }
  debugLog(`Docker pull completed after ${elapsedSeconds(pullStartMs)}s.`);

  const runResult = await runCommand("docker", buildDockerRunArgs(fullImage, inputs));
  const containerId = runResult.stdout.trim().split(/\r?\n/).find(Boolean) || "";

  if (!containerId) {
    throw new Error("docker run did not return a container ID");
  }

  debugLog(`Found sensor container ID: ${containerId}`);

  saveState(STARTED_STATE_KEY, "true");
  saveState(CONTAINER_ID_STATE_KEY, containerId);
  saveState(DEBUG_LOGS_STATE_KEY, debugLogsEnabled ? "true" : "false");

  if (inputs.waitForReady) {
    await waitForSensorReady(containerId);
  } else {
    log("Skipping Wiz Sensor readiness check (wait-for-ready=false).");
  }
}

module.exports = {
  runMain,
};

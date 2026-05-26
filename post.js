const { spawn } = require("child_process");

const STARTED_STATE_KEY = "WIZ_SENSOR_STARTED";
const CONTAINER_ID_STATE_KEY = "WIZ_SENSOR_CONTAINER_ID";
const DEBUG_LOGS_STATE_KEY = "WIZ_SENSOR_DEBUG_LOGS";
const SENSOR_STOP_TIMEOUT_S = 30;

let debugLogsEnabled = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function debugLog(message) {
  if (debugLogsEnabled) {
    log(`[debug] ${message}`);
  }
}

function emitWarning(message) {
  console.log(`::warning::${message}`);
}

async function runCommand(command, args, options = {}) {
  const { allowFailure = false } = options;
  const commandLine = [command, ...args].join(" ");
  debugLog(`Running command: ${commandLine}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
      debugLog(
        `Command finished: ${commandLine}\n  exit code: ${code}\n  stdout: ${stdout}\n  stderr: ${stderr}`,
      );

      if (code !== 0 && !allowFailure) {
        reject(new Error(`Command failed with exit code ${code}: ${commandLine}`));
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

async function runPost() {
  if (process.env[`STATE_${STARTED_STATE_KEY}`] !== "true") {
    return;
  }

  debugLogsEnabled = process.env[`STATE_${DEBUG_LOGS_STATE_KEY}`] === "true";

  const containerId = process.env[`STATE_${CONTAINER_ID_STATE_KEY}`] || "";

  if (!containerId) {
    log("No sensor container ID recorded during post-step cleanup.");
    return;
  }

  debugLog(`Sending stop command to sensor container ${containerId}`);
  const result = await runCommand(
    "docker",
    [
      "stop",
      "--time",
      String(SENSOR_STOP_TIMEOUT_S),
      containerId,
    ],
    { allowFailure: true },
  );
  debugLog(`Stop command returned for sensor container ${containerId} (exit code ${result.code})`);

  if (result.code !== 0) {
    emitWarning(`Failed to stop sensor container ${containerId} gracefully`);
  }

}

runPost().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  console.log("::warning::Wiz Sensor post-step cleanup encountered an error.");
});

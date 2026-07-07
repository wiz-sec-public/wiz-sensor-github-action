const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DefaultArtifactClient } = require("@actions/artifact");

const STARTED_STATE_KEY = "WIZ_SENSOR_STARTED";
const CONTAINER_ID_STATE_KEY = "WIZ_SENSOR_CONTAINER_ID";
const DEBUG_LOGS_STATE_KEY = "WIZ_SENSOR_DEBUG_LOGS";
const GENERATE_SUPPORT_PACKAGE_STATE_KEY = "WIZ_SENSOR_GENERATE_SUPPORT_PACKAGE";
const SUCCESS_STATE_KEY = "WIZ_SENSOR_SUCCESS";
const SENSOR_STOP_TIMEOUT_S = 30;
const SENSOR_STORE_PATH = "/opt/wiz/sensor-store";
const SENSOR_LOG_FILE_PREFIX = "sensor.log";
const SUPPORT_SCRIPT_URL = "https://downloads.wiz.io/sensor/sensor_support_linux.sh";
const SUPPORT_PACKAGE_FILENAME = "support_package_linux.tar.gz";
const ARTIFACT_BASE_NAME = "wiz-sensor-support-package";

const SENSOR_MARKER = "=== Ran with Wiz Sensor Github Action Marker ===";

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
  const { cwd, allowFailure = false } = options;
  const commandLine = [command, ...args].join(" ");
  debugLog(`Running command: ${commandLine}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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

function getArtifactFileName() {
  const job = String(process.env.GITHUB_JOB || "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const artifactName = job ? `${ARTIFACT_BASE_NAME}-${job}` : ARTIFACT_BASE_NAME;
  return `${artifactName}.tar.gz`;
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function uploadSupportPackage(filePath) {
  const artifact = new DefaultArtifactClient();
  const fileName = path.basename(filePath);
  const { id, size } = await artifact.uploadArtifact(
    fileName,
    [filePath],
    path.dirname(filePath),
    { skipArchive: true },
  );

  log(`Uploaded artifact "${fileName}" (${size || 0} bytes${id ? `, id ${id}` : ""}).`);
}

function get_log_files() {
  let entries;
  try {
    entries = fs.readdirSync(SENSOR_STORE_PATH, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      debugLog(`Sensor store path does not exist: ${SENSOR_STORE_PATH}`);
      return [];
    }

    emitWarning(
      `Failed to read Wiz Sensor log directory ${SENSOR_STORE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(SENSOR_LOG_FILE_PREFIX))
    .map((entry) => path.join(SENSOR_STORE_PATH, entry.name));
}

function read_log_file(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  } catch (error) {
    emitWarning(
      `Failed to read Wiz Sensor log file ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function check_line(line) {
  if (!line.trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return null;
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || parsed.level !== "ERROR") {
    return null;
  }

  return {
    timestamp: parsed.timestamp === undefined || parsed.timestamp === null ? "" : String(parsed.timestamp),
    line,
  };
}

function sort_line(left, right) {
  if (left.timestamp < right.timestamp) {
    return -1;
  }
  if (left.timestamp > right.timestamp) {
    return 1;
  }
  return 0;
}

function printSensorErrorLogs() {
  const errorLogs = [];

  for (const filePath of get_log_files()) {
    for (const line of read_log_file(filePath)) {
      const errorLog = check_line(line);
      if (errorLog) {
        errorLogs.push(errorLog);
      }
    }
  }

  errorLogs.sort(sort_line);

  if (errorLogs.length === 0) {
    return;
  }

  console.log("Wiz Sensor ERROR logs:");
  for (const { line } of errorLogs) {
    console.log(line);
  }
}

async function generateAndUploadSupportPackage() {
  const tmpBase = process.env.RUNNER_TEMP || os.tmpdir();
  const workDir = fs.mkdtempSync(path.join(tmpBase, "wiz-support-"));

  try {
    log("Collecting Wiz Sensor support package.");

    const scriptContent = await downloadText(SUPPORT_SCRIPT_URL);
    const scriptPath = path.join(workDir, "sensor_support_linux.sh");
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o700 });

    const result = await runCommand("sudo", ["bash", scriptPath], {
      cwd: workDir,
      allowFailure: true,
    });

    debugLog(`Support script exited with code ${result.code}.`);

    const packagePath = path.join(workDir, SUPPORT_PACKAGE_FILENAME);
    if (!fs.existsSync(packagePath)) {
      throw new Error(
        `support script did not produce ${SUPPORT_PACKAGE_FILENAME} (exit code ${result.code})`,
      );
    }

    await runCommand("sudo", ["chmod", "0644", packagePath], { allowFailure: true });

    const uploadPath = path.join(workDir, getArtifactFileName());
    fs.renameSync(packagePath, uploadPath);

    const { size } = fs.statSync(uploadPath);
    log(`Support package collected (${size} bytes). Uploading as artifact "${path.basename(uploadPath)}".`);

    await uploadSupportPackage(uploadPath);
  } finally {
    await runCommand("sudo", ["rm", "-rf", workDir], { allowFailure: true }).catch(() => {});
  }
}

async function runPost() {
  if (process.env[`STATE_${STARTED_STATE_KEY}`] !== "true") {
    return;
  }

  debugLogsEnabled = process.env[`STATE_${DEBUG_LOGS_STATE_KEY}`] === "true";

  const containerId = process.env[`STATE_${CONTAINER_ID_STATE_KEY}`] || "";

  if (process.env[`STATE_${GENERATE_SUPPORT_PACKAGE_STATE_KEY}`] === "true") {
    try {
      await generateAndUploadSupportPackage();
    } catch (error) {
      emitWarning(
        `Failed to generate or upload the Wiz Sensor support package: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!containerId) {
    log("No sensor container ID recorded during post-step cleanup.");
    return;
  }

  if (process.env[`STATE_${SUCCESS_STATE_KEY}`] === "true") {
    console.log(`${SENSOR_MARKER} ${process.env.GITHUB_WORKFLOW || ""}`);
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

  printSensorErrorLogs();
}

runPost().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  console.log("::warning::Wiz Sensor post-step cleanup encountered an error.");
});

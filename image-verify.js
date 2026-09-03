const crypto = require("crypto");

// Source: https://downloads.wiz.io/wiz-verification-key.pub
const WIZ_IMAGE_SIGNING_PUBLIC_KEY = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAzpgeliOKL0uTB55NhVPV
DfmDKroRY1QTqCQN2i24bxCUZCVAVInY0HK6kgZEci9Y+HSb7zggcwmVhHlSgwXr
OhO+956DA3VAFsSB0E2IZ5UFGqlkVAjhnpYb/166ON6eN9bpkXFkb60OQ20HlBlS
QXGWV2rU0XDmfaRZpilwaVd6C0hAt+Q4ataQSY5WhXHB4ZQzu50nK2XvXZRAStbx
ndASz4MDwRvIg6hCkCh5s+slXudlSAEnyckTnZgR8Msr4XhytJVeGet2BYfoQCg2
79kXt4iJLwluLsgVBDXr7KDB8/5OWdtnYqAOoFj6oe6AfmHmIDYQxtnLHo/x00/J
N7u1VruuY1SYpJeotz2MVp2yzrt96jGOpml+4c1AJ8/NQBuACpZZLPC01nlGtQyO
Swr783wX+y43WTf1q7C7EvBpFxAUREXhWxBiLiVcxH+MWuTBwo4aGRyH+ts0d5PH
Oj+xARQSwsZbyxYT57fYkG+UyXzsoqMcqSlV+D6veRbnBv5YIX3fuNf4d8KGqw/p
JReJZiD7z4cxuhll4WjUWfJHZ7Pdozt0NIjvIeqmjtSy2dUn0i6ZOnN1VdploGAk
U+rHHXAANzgDaqKPp3gJHuD8ydwc+x7QDRFhuQbjlcPEt69gdHf/vFVbrSfIhLUy
uHetslQZBY8HfJkpn0y5qucCAwEAAQ==
-----END PUBLIC KEY-----
`);

const COSIGN_SIGNATURE_ANNOTATION = "dev.cosignproject.cosign/signature";
const SIMPLE_SIGNING_MEDIA_TYPE = "application/vnd.dev.cosign.simplesigning.v1+json";
const MANIFEST_ACCEPT_TYPES =
  "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const REGISTRY_REQUEST_TIMEOUT_MS = 30000;

async function registryRequest(url, headers = {}) {
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
  });
}

function parseAuthenticateHeader(header) {
  const [, scheme = "", params = ""] = header.match(/^(\S+)\s*(.*)$/) || [];
  const fields = {};

  for (const match of params.matchAll(/(\w+)="([^"]*)"/g)) {
    fields[match[1]] = match[2];
  }

  return { scheme: scheme.toLowerCase(), fields };
}

// Handle the Basic and Bearer challenges used by Docker Registry HTTP API V2.
async function getAuthorizationHeader(registryUrl, repository, username, password) {
  const probe = await registryRequest(`https://${registryUrl}/v2/`);

  if (probe.ok) {
    return null;
  }

  if (probe.status !== 401) {
    throw new Error(`Registry ${registryUrl} responded with unexpected status ${probe.status}`);
  }

  const challenge = probe.headers.get("www-authenticate");

  if (!challenge) {
    throw new Error(`Registry ${registryUrl} requires authentication but sent no WWW-Authenticate challenge`);
  }

  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const { scheme, fields } = parseAuthenticateHeader(challenge);

  if (scheme === "basic") {
    return basic;
  }

  if (scheme !== "bearer" || !fields.realm) {
    throw new Error(`Registry ${registryUrl} requested unsupported authentication: ${challenge}`);
  }

  const tokenUrl = new URL(fields.realm);

  if (fields.service) {
    tokenUrl.searchParams.set("service", fields.service);
  }

  tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);

  const tokenResponse = await registryRequest(tokenUrl, { authorization: basic });

  if (!tokenResponse.ok) {
    throw new Error(`Failed to obtain a pull token from ${fields.realm}: status ${tokenResponse.status}`);
  }

  const tokenPayload = await tokenResponse.json();
  const token = tokenPayload.token || tokenPayload.access_token;

  if (!token) {
    throw new Error(`Token endpoint ${fields.realm} returned no token`);
  }

  return `Bearer ${token}`;
}

async function fetchSignatureManifest(registryUrl, repository, signatureTag, authorization) {
  const headers = { accept: MANIFEST_ACCEPT_TYPES };

  if (authorization) {
    headers.authorization = authorization;
  }

  const response = await registryRequest(
    `https://${registryUrl}/v2/${repository}/manifests/${signatureTag}`,
    headers,
  );

  if (response.status === 404) {
    throw new Error(`No Wiz signature found in ${registryUrl}/${repository} (missing tag ${signatureTag})`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch signature manifest ${signatureTag}: status ${response.status}`);
  }

  return response.json();
}

async function fetchBlob(registryUrl, repository, digest, authorization) {
  const headers = {};

  if (authorization) {
    headers.authorization = authorization;
  }

  const response = await registryRequest(`https://${registryUrl}/v2/${repository}/blobs/${digest}`, headers);

  if (!response.ok) {
    throw new Error(`Failed to fetch signature payload blob ${digest}: status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// Cosign stores signatures under the sha256-<digest>.sig tag.
async function verifySensorImageSignature({
  registryUrl,
  imageName,
  imageDigest,
  username,
  password,
  debugLog = () => {},
}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error(`Unexpected image digest format: ${imageDigest}`);
  }

  const registry = registryUrl.toLowerCase();
  const repository = imageName.toLowerCase();
  const signatureTag = `${imageDigest.replace(":", "-")}.sig`;

  const authorization = await getAuthorizationHeader(registry, repository, username, password);
  const manifest = await fetchSignatureManifest(registry, repository, signatureTag, authorization);

  const layers = (manifest.layers || []).filter((layer) => layer.mediaType === SIMPLE_SIGNING_MEDIA_TYPE);

  if (layers.length === 0) {
    throw new Error(`Signature manifest ${signatureTag} contains no cosign signatures`);
  }

  const failures = [];

  for (const layer of layers) {
    const signatureBase64 = layer.annotations?.[COSIGN_SIGNATURE_ANNOTATION];

    if (!signatureBase64) {
      failures.push(`layer ${layer.digest}: missing signature annotation`);
      continue;
    }

    const payload = await fetchBlob(registry, repository, layer.digest, authorization);
    const payloadDigest = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;

    if (payloadDigest !== layer.digest) {
      failures.push(`layer ${layer.digest}: payload digest mismatch (${payloadDigest})`);
      continue;
    }

    let signedDigest;

    try {
      signedDigest = JSON.parse(payload.toString("utf8")).critical.image["docker-manifest-digest"];
    } catch {
      failures.push(`layer ${layer.digest}: malformed signature payload`);
      continue;
    }

    if (signedDigest !== imageDigest) {
      failures.push(`layer ${layer.digest}: signature covers digest ${signedDigest}`);
      continue;
    }

    if (crypto.verify("sha256", payload, WIZ_IMAGE_SIGNING_PUBLIC_KEY, Buffer.from(signatureBase64, "base64"))) {
      debugLog(`Image digest ${imageDigest} verified by signature layer ${layer.digest}`);
      return;
    }

    failures.push(`layer ${layer.digest}: signature does not verify against the Wiz public key`);
  }

  throw new Error(`Wiz Sensor image signature verification failed for ${imageDigest}: ${failures.join("; ")}`);
}

module.exports = {
  verifySensorImageSignature,
};

// vm-control — generic token-gated control endpoint for a single environment:
//   ?action=status|start|stop   — GCE instance lifecycle
//   ?action=deploy&name=&sha=   — install a pre-published extension artifact
//                                 from the artifact bucket onto the VM
//
// Companion to the directus-deploy CLI:
//   directus-deploy vm <status|start|stop> --target <name>
//   directus-deploy extensions promote <ext> --target <name> --via control
//
// The CLI reads the endpoint URL from the targets file (`control_url`) and
// authenticates with a shared token (X-Control-Token) plus — when the org
// forbids public endpoints — a Google ID token from an invoker-only SA.
// Callers hold only URL + tokens; the real permissions live on this
// function's service account:
//   - compute.instanceAdmin.v1 on the ONE instance (start/stop)
//   - secretmanager.secretAccessor on the deploy SSH key (deploy)
//
// deploy runs the exact same per-file atomic install script as
// `extensions promote` over SSH — executed from inside GCP, where port 22
// egress works (agent sandboxes typically block outbound SSH). The artifact
// MUST already exist in the bucket (first-write-wins, .sha256 sidecar);
// this endpoint never builds anything.
//
// Deploy + IAM: see README.md in this directory.

const { InstancesClient } = require("@google-cloud/compute");
const crypto = require("node:crypto");

const PROJECT = process.env.VM_PROJECT;
const ZONE = process.env.VM_ZONE;
const INSTANCE = process.env.VM_INSTANCE;

// deploy-action config (all optional — deploy 400s when unset)
const SSH_HOST = process.env.SSH_HOST;
const SSH_USER = process.env.SSH_USER || "runner";
const SSH_KEY_SECRET = process.env.SSH_KEY_SECRET; // projects/<p>/secrets/<name>/versions/latest
const REMOTE_EXTENSIONS_PATH = process.env.REMOTE_EXTENSIONS_PATH || "/var/www/cms/extensions";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET; // gs://bucket

// Shared-token check is OPTIONAL defense-in-depth: when CONTROL_TOKEN is
// unset, auth rests entirely on the platform layer (Cloud Run IAM — the
// invoker SA — which domain-restricted orgs enforce anyway). Set it only if
// you also expose the function publicly (--allow-unauthenticated).
function tokenOk(req) {
  const want = process.env.CONTROL_TOKEN || "";
  if (!want) return true;
  const got = req.get("x-control-token") || "";
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function fetchSshKey() {
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: SSH_KEY_SECRET });
  return version.payload.data.toString("utf8");
}

// The verbatim install script from `extensions promote` (see the CLI's
// src/extensions.ts promoteExtension): fetch artifact + sidecar via gsutil ON
// THE VM, verify sha256, per-file atomic mv into dist/ so chokidar's
// per-inode watch fires. Stale *.js cleared first.
function installScript(name, sha) {
  const remoteExt = `${REMOTE_EXTENSIONS_PATH.replace(/\/+$/, "")}/${name}`;
  const artifactUri = `${ARTIFACT_BUCKET.replace(/\/+$/, "")}/${name}/${sha}.tgz`;
  return (
    `set -e; ` +
    `mkdir -p ${remoteExt}/dist; ` +
    `TMPDIR=$(mktemp -d); ` +
    `gsutil -q cp '${artifactUri}' "$TMPDIR/artifact.tgz"; ` +
    `gsutil -q cp '${artifactUri}.sha256' "$TMPDIR/artifact.sha256" || true; ` +
    `if [ -s "$TMPDIR/artifact.sha256" ]; then ` +
    `  want=$(awk '{print $1}' "$TMPDIR/artifact.sha256"); ` +
    `  got=$(sha256sum "$TMPDIR/artifact.tgz" | awk '{print $1}'); ` +
    `  if [ "$want" != "$got" ]; then echo "sha256 mismatch: want $want got $got" >&2; exit 1; fi; ` +
    `fi; ` +
    `tar -C "$TMPDIR" -xzf "$TMPDIR/artifact.tgz"; ` +
    `find ${remoteExt}/dist -maxdepth 1 -type f -name '*.js' -delete; ` +
    `for f in "$TMPDIR"/dist/*.js; do ` +
    `  base=$(basename "$f"); ` +
    `  cp "$f" "${remoteExt}/dist/.$base.new"; ` +
    `  mv "${remoteExt}/dist/.$base.new" "${remoteExt}/dist/$base"; ` +
    `done; ` +
    `if [ -f "$TMPDIR/package.json" ]; then ` +
    `  cp "$TMPDIR/package.json" "${remoteExt}/package.json.new"; ` +
    `  mv "${remoteExt}/package.json.new" "${remoteExt}/package.json"; ` +
    `fi; ` +
    `rm -rf "$TMPDIR"; ` +
    `echo installed`
  );
}

function sshExec(privateKey, command) {
  const { Client } = require("ssh2");
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          stream
            .on("data", (d) => (stdout += d.toString()))
            .stderr.on("data", (d) => (stderr += d.toString()));
          stream.on("close", (code) => {
            conn.end();
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`remote install exited ${code}: ${stderr.trim() || stdout.trim()}`));
          });
        });
      })
      .on("error", reject)
      .connect({
        host: SSH_HOST,
        port: 22,
        username: SSH_USER,
        privateKey,
        readyTimeout: 20000,
      });
  });
}

async function handleDeploy(req, res) {
  if (!SSH_HOST || !SSH_KEY_SECRET || !ARTIFACT_BUCKET) {
    res.status(400).json({ error: "deploy not configured on this function (SSH_HOST/SSH_KEY_SECRET/ARTIFACT_BUCKET unset)" });
    return;
  }
  const name = (req.query.name || req.body?.name || "").toString();
  const sha = (req.query.sha || req.body?.sha || "").toString();
  // Tight validation — these are interpolated into a remote shell command.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    res.status(400).json({ error: "invalid extension name" });
    return;
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    res.status(400).json({ error: "invalid sha (expect 7-40 hex chars)" });
    return;
  }
  const started = Date.now();
  const privateKey = await fetchSshKey();
  const { stdout } = await sshExec(privateKey, installScript(name, sha));
  res.json({
    action: "deploy",
    extension: name,
    sha,
    artifact: `${ARTIFACT_BUCKET.replace(/\/+$/, "")}/${name}/${sha}.tgz`,
    durationMs: Date.now() - started,
    remote: stdout.trim(),
  });
}

exports.vmControl = async (req, res) => {
  if (!PROJECT || !ZONE || !INSTANCE) {
    res.status(500).json({ error: "function misconfigured: VM_PROJECT/VM_ZONE/VM_INSTANCE unset" });
    return;
  }
  if (!tokenOk(req)) {
    res.status(401).json({ error: "bad or missing X-Control-Token" });
    return;
  }
  const action = (req.query.action || req.body?.action || "status").toString();
  if (!["start", "stop", "status", "deploy"].includes(action)) {
    res.status(400).json({ error: `unknown action '${action}' (start|stop|status|deploy)` });
    return;
  }

  try {
    if (action === "deploy") {
      await handleDeploy(req, res);
      return;
    }

    const client = new InstancesClient();
    const ref = { project: PROJECT, zone: ZONE, instance: INSTANCE };
    const [before] = await client.get(ref);
    const result = { instance: INSTANCE, zone: ZONE, action, statusBefore: before.status };

    if (action === "start" && before.status !== "RUNNING") {
      await client.start(ref); // async GCP operation — instance boots over the next ~1-2 min
      result.operation = "start dispatched";
    } else if (action === "stop" && before.status === "RUNNING") {
      await client.stop(ref);
      result.operation = "stop dispatched";
    } else if (action !== "status") {
      result.operation = `no-op (already ${before.status})`;
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

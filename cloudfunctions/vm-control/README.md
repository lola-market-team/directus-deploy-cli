# vm-control

Generic token-gated HTTPS endpoint for one environment:

- `?action=status|start|stop` — GCE instance lifecycle
- `?action=deploy&name=<ext>&sha=<short-sha>` — install a pre-published
  extension artifact from the artifact bucket onto the VM (the exact
  `extensions promote` install script, executed over SSH from inside GCP —
  callers need no SSH egress)

Deploy one function per controllable environment (typically just the test box
— never wire this to a prod instance).

## deploy-action prerequisites (skip if you only need start/stop)

```bash
# SSH key into Secret Manager + let the function's SA read it
gcloud services enable secretmanager.googleapis.com
gcloud secrets create lola-ext-ssh-key --data-file="$HOME/.ssh/<deploy-key>" --replication-policy=automatic
gcloud secrets add-iam-policy-binding lola-ext-ssh-key \
  --member="serviceAccount:${NAME}@${PROJECT}.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Add to the deploy command's `--set-env-vars`:
`SSH_HOST=<vm-ip>,SSH_USER=runner,SSH_KEY_SECRET=projects/<p>/secrets/lola-ext-ssh-key/versions/latest,REMOTE_EXTENSIONS_PATH=/var/www/cms/extensions,ARTIFACT_BUCKET=gs://lola-market-extensions`
and use `--timeout=180s` (SSH + gsutil pull on the VM can exceed the 60s default).

Companion of the CLI command:

```bash
directus-deploy vm status --target test
directus-deploy vm start  --target test   # waits until /server/health answers
directus-deploy vm stop   --target test
```

The CLI resolves the endpoint from the targets file and the token from env:

```jsonc
// directus-deploy.targets.json
"test": {
  "base_url": "https://test.example.com",
  "control_url": "https://europe-west1-<project>.cloudfunctions.net/test-vm-control",
  "control_token_env": "DIRECTUS_TEST_CONTROL_TOKEN"   // optional; this is the default pattern
}
```

Callers hold only URL + token. The compute permission lives on the function's
service account, IAM-bound to the ONE instance named at deploy time.

## One-time deploy per instance (authed gcloud, from this directory)

```bash
PROJECT=$(gcloud config get-value project)
INSTANCE=lola-test            # the GCE instance to control
ZONE=europe-west1-b
NAME=test-vm-control          # function name, one per instance

# 1. Runtime service account, allowed to manage ONLY this instance
gcloud iam service-accounts create "$NAME"
gcloud compute instances add-iam-policy-binding "$INSTANCE" --zone="$ZONE" \
  --member="serviceAccount:${NAME}@${PROJECT}.iam.gserviceaccount.com" \
  --role=roles/compute.instanceAdmin.v1

# 2. Shared token — OPTIONAL. Only needed when the function is publicly
#    invokable (--allow-unauthenticated). IAM-gated deployments (invoker SA,
#    the default in domain-restricted orgs) need no token at all: omit
#    CONTROL_TOKEN from the env vars and the function relies on Cloud Run IAM.
TOKEN=$(openssl rand -hex 32)

# 3. Deploy (gen2). --allow-unauthenticated only works if your org policy
#    permits allUsers bindings; otherwise deploy without it and use an
#    invoker SA (see below).
gcloud functions deploy "$NAME" \
  --gen2 --region="${ZONE%-*}" --runtime=nodejs20 \
  --source=. --entry-point=vmControl --trigger-http --allow-unauthenticated \
  --service-account="${NAME}@${PROJECT}.iam.gserviceaccount.com" \
  --set-env-vars "VM_PROJECT=${PROJECT},VM_ZONE=${ZONE},VM_INSTANCE=${INSTANCE},CONTROL_TOKEN=${TOKEN}"

echo "control token: ${TOKEN}"
gcloud functions describe "$NAME" --gen2 --region="${ZONE%-*}" --format='value(serviceConfig.uri)'
```

Then: put the URL into the targets file (`control_url`) and the token into
every caller's env under `DIRECTUS_<TARGET>_CONTROL_TOKEN`.

## Raw usage (without the CLI)

```bash
curl -fsS -X POST -H "X-Control-Token: $TOKEN" "$URL?action=status"
curl -fsS -X POST -H "X-Control-Token: $TOKEN" "$URL?action=start"
curl -fsS -X POST -H "X-Control-Token: $TOKEN" "$URL?action=stop"
```

`start`/`stop` dispatch the GCP operation and return immediately (boot takes
~1–2 min plus app containers).

## Scheduled nightly stop (replaces CI-based stop jobs)

```bash
gcloud scheduler jobs create http test-vm-nightly-stop \
  --location="${ZONE%-*}" --schedule="0 22 * * *" --time-zone="Europe/Vienna" \
  --uri="${URL}?action=stop" --http-method=POST \
  --headers="X-Control-Token=${TOKEN}"
```

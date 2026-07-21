import { readFile } from "node:fs/promises";

// The targets file (directus-deploy.targets.json) — one entry per environment.
// Shared by extensions push/promote, overview, and vm control.

export interface TargetsFile {
  targets: Record<string, TargetConfig>;
}

export interface TargetConfig {
  base_url: string;                // https://test.lola.market — for /_meta verify + health
  ssh_host: string;                // hostname/IP the SSH client resolves
  ssh_user: string;                // the user on the VM (typically "runner")
  remote_extensions_path: string;  // e.g. /opt/directus/extensions
  ssh_key_env?: string;            // env var holding path to private key (defaults to $LOLA_EXT_SSH_KEY)
  artifact_bucket?: string;        // gs:// URI for build-once/promote-many artifacts (default: gs://lola-market-extensions)
  build_forbidden?: boolean;       // set true for prod-like targets: `promote` refuses when the artifact is missing instead of building
  ref?: string;                    // git ref this env is deployed from (e.g. "origin/develop") — used by `overview`
  token_env?: string;              // env var holding the admin token (default: DIRECTUS_<UPPER>_TOKEN)
  control_url?: string;            // vm-control endpoint (cloudfunctions/vm-control) — used by `vm start|stop|status` and `promote --via control`
  control_token_env?: string;      // env var holding the control token (default: DIRECTUS_<UPPER>_CONTROL_TOKEN)
  control_invoker_key_env?: string; // env var holding a base64 SA key with run.invoker on the control fn, for orgs that forbid public endpoints (default: DIRECTUS_<UPPER>_INVOKER_KEY_B64)
}

export async function loadTargets(path: string): Promise<TargetsFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as TargetsFile;
  if (!parsed?.targets || typeof parsed.targets !== "object") {
    throw new Error(`invalid targets file at ${path}: missing 'targets' object`);
  }
  return parsed;
}

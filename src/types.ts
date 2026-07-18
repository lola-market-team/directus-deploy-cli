export type EntityKind =
  | "collections"
  | "fields"
  | "relations"
  | "policies"
  | "roles"
  | "permissions"
  | "flows"
  | "operations"
  | "migrations"
  | "seeds";

export interface EntityResult {
  kind: EntityKind;
  label: string; // e.g. "collections/listings", "fields/listings.title"
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  reason?: string; // human-readable, especially for skipped/failed
}

export interface RunReport {
  target: string;
  results: EntityResult[];
  counts: Record<EntityResult["action"], number>;
}

export interface DirectusClient {
  get(path: string): Promise<Record<string, unknown> | Record<string, unknown>[] | null>;
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
  patch(path: string, body: unknown): Promise<Record<string, unknown>>;
  delete(path: string): Promise<void>;
  // Non-standard endpoints (/raw-query/execute, extension routes) return
  // their payload at the response root, not under `.data`. `postRaw` returns
  // the full parsed body untouched.
  postRaw(path: string, body: unknown): Promise<Record<string, unknown>>;
}

export interface ApplyOptions {
  dryRun: boolean;
  onlyCollections?: Set<string>;
}

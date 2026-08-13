/* Id-stable persistence for RFQs and quotes.
 *
 * WHY THIS EXISTS — the bug it replaces:
 * The original save path deleted every rfq_items row and re-inserted with new
 * UUIDs. Because quote_items.rfq_item_id is `references rfq_items(id) on
 * delete cascade`, correcting a typo in an RFQ silently cascaded away every
 * supplier quote line already collected against it. The quotes headers
 * survived (they reference rfqs), so nothing errored and nothing warned —
 * Compare simply showed every supplier as "not quoted".
 *
 * The same destroy-and-recreate shape in saveQuotes() meant a failure partway
 * through the re-insert loop left the earlier quotes permanently deleted.
 *
 * Both are fixed the same way: diff against the ids already on the server.
 * Update what exists, insert only what is new, and delete only what the user
 * genuinely removed. That keeps rfq_items.id stable across edits, so the
 * foreign keys — and the quotes — hold. It is also what makes autosave safe:
 * a delete-everything write cannot run on every keystroke.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PersistError {
  message: string;
}

/** One row to persist, with `id` present only if it already exists server-side. */
export interface Persistable {
  id?: string;
  [key: string]: unknown;
}

/**
 * Reconcile a set of child rows against the server.
 *
 * Deletes are computed from the ids that were loaded but are no longer
 * present, and are issued LAST so a failed insert/update never leaves the
 * caller with less data than they started with.
 *
 * Returns the ids of rows as they now exist, in the same order as `rows`.
 */
export async function syncRows(
  sb: SupabaseClient,
  table: string,
  rows: Persistable[],
  knownIds: string[]
): Promise<{ ids: string[]; error: PersistError | null }> {
  const keptIds = rows.map((r) => r.id).filter((x): x is string => !!x);
  const removed = knownIds.filter((id) => !keptIds.includes(id));

  const resultIds: string[] = new Array(rows.length);

  // 1. Updates (existing rows) — run in parallel, they're independent.
  const updates = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !!r.id);
  const updateResults = await Promise.all(
    updates.map(({ r }) => {
      const { id, ...patch } = r;
      return sb.from(table).update(patch).eq("id", id as string);
    })
  );
  for (const res of updateResults) {
    if (res.error) return { ids: [], error: { message: res.error.message } };
  }
  for (const { r, i } of updates) resultIds[i] = r.id as string;

  // 2. Inserts (new rows) — one batched call, so it is atomic per statement.
  const inserts = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.id);
  if (inserts.length > 0) {
    const payload = inserts.map(({ r }) => {
      const { id: _drop, ...rest } = r;
      void _drop;
      return rest;
    });
    const { data, error } = await sb.from(table).insert(payload).select("id");
    if (error) return { ids: [], error: { message: error.message } };
    const newIds = (data ?? []).map((d: { id: string }) => d.id);
    if (newIds.length !== inserts.length) {
      return { ids: [], error: { message: `${table}: expected ${inserts.length} inserted rows, got ${newIds.length}` } };
    }
    inserts.forEach(({ i }, n) => { resultIds[i] = newIds[n]; });
  }

  // 3. Deletes last — only rows the user actually removed.
  if (removed.length > 0) {
    const { error } = await sb.from(table).delete().in("id", removed);
    if (error) return { ids: [], error: { message: error.message } };
  }

  return { ids: resultIds, error: null };
}

/** Debounce helper for autosave. Returns a callable with a `flush` method. */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      if (lastArgs) fn(...lastArgs);
    }
  };
  wrapped.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  return wrapped;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

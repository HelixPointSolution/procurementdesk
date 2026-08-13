"use client";

import type { SaveState } from "@/lib/persist";

/** Inline autosave status. Replaces the old Save buttons and alert() dialogs —
 *  autosave must never pop a modal in the middle of typing. */
export default function SaveIndicator({
  state, error, onRetry,
}: {
  state: SaveState;
  error?: string;
  onRetry?: () => void;
}) {
  if (state === "saving") {
    return <span className="text-sm text-gray-500" role="status">Saving…</span>;
  }
  if (state === "saved") {
    return <span className="text-sm text-green-700" role="status">Saved ✓</span>;
  }
  if (state === "error") {
    return (
      <span className="text-sm text-red-700" role="alert">
        Not saved — {error || "unknown error"}
        {onRetry && (
          <button onClick={onRetry} className="ml-2 underline font-medium">
            Retry
          </button>
        )}
      </span>
    );
  }
  return null;
}

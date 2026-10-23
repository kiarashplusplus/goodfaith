"use client";

import { usePool } from "@/lib/hooks";

/** Shown when the pool on chain doesn't match the pinned configuration. All actions stay disabled. */
export function PoolWarning() {
  const { error } = usePool();
  if (!error) return null;
  return (
    <div className="bg-red-100 px-3 py-2 text-center text-sm text-red-900">
      {error instanceof Error ? error.message : "The fund couldn't be verified."} Transactions are turned off.
    </div>
  );
}

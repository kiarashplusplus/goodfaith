"use client";

import { usePool } from "@/lib/hooks";

/**
 * Shown when the app isn't configured or the pool on chain doesn't match the pinned configuration.
 * Every loan action needs the verified pool, so they stay off; plain wallet transfers still work.
 */
export function PoolWarning() {
  const { error } = usePool();
  if (!error) return null;
  return (
    <div role="alert" className="bg-red-100 px-3 py-2 text-center text-sm text-red-900">
      {error instanceof Error ? error.message : "The fund couldn't be verified."} Borrowing, co-signing, repaying and donating are turned
      off. Sending and receiving still work.
    </div>
  );
}

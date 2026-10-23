"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Copy text to the clipboard; false when it isn't available (insecure context, permission denied). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type CopyState = "idle" | "copied" | "failed";

/** Copy with a short-lived "Copied" / "Couldn't copy" state for the button label. */
export function useCopy(resetMs = 1500) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      setState(ok ? "copied" : "failed");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), resetMs);
    },
    [resetMs],
  );
  return { state, copy };
}

export function copyLabel(state: CopyState, idle: string): string {
  return state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy. Select the text instead." : idle;
}

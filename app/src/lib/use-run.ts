"use client";

import { useCallback, useRef, useState } from "react";
import { friendlyError } from "./program";

/** Runs an async action with busy/error/result state. Ignores double clicks while busy. */
export function useRun<T = string>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const lock = useRef(false);
  const run = useCallback(async (fn: () => Promise<T>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      console.error(e);
      setError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  return {
    run,
    busy,
    error,
    result,
    reset: () => {
      setResult(null);
      setError(null);
    },
  };
}

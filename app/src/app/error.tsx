"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";

/** Route error boundary (Next.js `error.tsx`). Wallet and fund state are untouched; retry re-renders the page. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Card title="Something went wrong">
      <p className="mb-4 text-sm text-stone-700">
        The page hit an unexpected error. Nothing was sent to the network. You can try again, or go back to Checking.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/" className="rounded-xl border border-stone-300 px-4 py-2 font-medium text-stone-800 hover:bg-stone-100">
          Go to Checking
        </Link>
      </div>
    </Card>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Card title="That page doesn't exist">
      <p className="mb-4 text-sm text-stone-700">Check the address, or start again from Checking.</p>
      <Link href="/" className="underline">
        Go to Checking
      </Link>
    </Card>
  );
}

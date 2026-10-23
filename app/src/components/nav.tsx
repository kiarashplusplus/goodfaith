"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./connect-button";

const LINKS = [
  ["/", "Checking"],
  ["/borrow", "Borrow"],
  ["/repay", "Repay"],
  ["/donate", "Donate"],
  ["/fund", "Fund"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="text-xl font-bold text-emerald-800">
          Good Faith
        </Link>
        <nav className="flex gap-1 text-sm">
          {LINKS.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={`rounded-lg px-3 py-1.5 ${path === href ? "bg-emerald-100 text-emerald-900" : "text-stone-700 hover:bg-stone-100"}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}

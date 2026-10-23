"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./connect-button";

const LINKS = [
  ["/", "Checking"],
  ["/join", "Join"],
  ["/borrow", "Borrow"],
  ["/cosign", "Co-sign"],
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
        <nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
          {LINKS.map(([href, label]) => {
            const current = path === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? "page" : undefined}
                className={`rounded-lg px-3 py-1.5 ${current ? "bg-emerald-100 text-emerald-900" : "text-stone-700 hover:bg-stone-100"}`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}

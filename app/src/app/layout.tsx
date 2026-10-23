import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Banners } from "@/components/banners";
import { Nav } from "@/components/nav";
import { PoolWarning } from "@/components/pool-warning";

export const metadata: Metadata = {
  title: { default: "Good Faith — loans with no interest and no fees", template: "%s | Good Faith" },
  description: "You pay back exactly what you borrow. No interest. No fees. Texas residents only.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <Banners />
          <PoolWarning />
          <Nav />
          <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
          <footer className="mx-auto max-w-4xl px-4 pb-10 text-xs text-stone-500">
            Good Faith never holds your money. Your wallet does. Loans are available to verified Texas residents only.
          </footer>
        </Providers>
      </body>
    </html>
  );
}

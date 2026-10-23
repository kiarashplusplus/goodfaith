import type { Metadata } from "next";

export const metadata: Metadata = { title: "Join" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

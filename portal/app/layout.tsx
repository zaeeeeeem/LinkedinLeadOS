import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = { title: "LeadsOS Portal" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen bg-zinc-50 text-zinc-900">
        <nav className="w-48 shrink-0 border-r border-zinc-200 bg-white p-4">
          <div className="mb-6 text-sm font-bold tracking-wide">LeadsOS</div>
          <ul className="space-y-1 text-sm">
            <li><Link className="block rounded px-2 py-1 hover:bg-zinc-100" href="/">Pipeline</Link></li>
            <li><Link className="block rounded px-2 py-1 hover:bg-zinc-100" href="/searches">Searches</Link></li>
            <li><Link className="block rounded px-2 py-1 hover:bg-zinc-100" href="/machine">Machine</Link></li>
          </ul>
        </nav>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </body>
    </html>
  );
}

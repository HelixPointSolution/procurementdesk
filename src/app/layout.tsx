import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AuthGate from "@/components/AuthGate";
import Nav from "@/components/Nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Helix Point — Procurement Desk",
  description: "RFQ · Quote Comparison · Supplier Scorecard · Purchase History",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthGate>
          <Nav />
          {/* Narrow readable column, as v1 had — a wide form sprawls and is
              harder to scan than one that fits the eye. */}
          <main className="max-w-5xl w-full mx-auto px-4 py-6 flex-1">{children}</main>
        </AuthGate>
      </body>
    </html>
  );
}

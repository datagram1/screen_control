import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "ScreenControl - AI-Powered Remote Desktop & Browser Automation",
    template: "%s | ScreenControl",
  },
  description: "Cross-platform AI agents for remote computer management and desktop automation. Control your computer with Claude AI through MCP (Model Context Protocol). Supports macOS, Linux, and Windows for screen control, keyboard/mouse automation, browser automation, filesystem management, and remote system monitoring.",
  keywords: [
    "ScreenControl",
    "AI desktop automation",
    "remote computer control",
    "remote desktop management",
    "AI-powered automation",
    "Claude AI integration",
    "MCP Model Context Protocol",
    "browser automation",
    "screen recording software",
    "keyboard automation",
    "mouse control automation",
    "computer management software",
    "AI agents",
    "desktop control",
    "remote system monitoring",
    "cross-platform automation",
    "macOS automation",
    "Linux automation",
    "Windows automation",
    "filesystem management",
    "shell execution",
    "system tools",
    "window management",
    "clipboard automation",
    "OCR screen analysis",
    "remote desktop AI",
    "AI computer control",
    "automated testing",
    "Playwright alternative",
    "desktop AI assistant"
  ],
  authors: [{ name: "ScreenControl" }],
  creator: "ScreenControl",
  publisher: "ScreenControl",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "ScreenControl",
    title: "ScreenControl - AI-Powered Remote Desktop & Browser Automation",
    description: "Cross-platform AI agents for remote computer management and desktop automation. Control your computer with Claude AI through MCP protocol.",
  },
  twitter: {
    card: "summary_large_image",
    title: "ScreenControl - AI-Powered Remote Desktop & Browser Automation",
    description: "Cross-platform AI agents for remote computer management and desktop automation.",
  },
  verification: {
    google: "ea5eb66e334968a6",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

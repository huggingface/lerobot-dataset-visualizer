import type { Metadata } from "next";
import { IBM_Plex_Mono, Source_Sans_3 } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/auth-context";
import { THEME_INIT_SCRIPT } from "@/utils/theme-init";

// The Hub's (moon-landing) type: Source Sans Pro, published on Google Fonts as Source Sans 3, and
// IBM Plex Mono. Exposed as variables on <html> so Tailwind's font-sans / font-mono resolve there.
const sans = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-source-sans",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "LeRobot Dataset Tool and Visualizer",
  description: "Tool and Visualizer for LeRobot Datasets",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The init script sets the theme class before hydration, hence the warning suppression.
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

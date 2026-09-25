import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/auth-context";
import { THEME_INIT_SCRIPT } from "@/utils/theme-init";

const inter = Inter({ subsets: ["latin"] });

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={inter.className}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

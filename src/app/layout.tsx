import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/auth-context";
import HfAuthButton from "@/components/hf-auth-button";

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
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <div className="fixed top-3 right-3 z-50">
            <HfAuthButton />
          </div>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}

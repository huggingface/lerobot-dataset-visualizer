"use client";

import { useState } from "react";
import { InlineLoading } from "@/components/ui";
import { useTheme } from "@/utils/theme";

const DOCTOR_SPACE = "https://jashshah999-lerobot-doctor.hf.space/";

/** The lerobot-doctor Space, embedded for this dataset. */
export default function DoctorPanel({ repoId }: { repoId: string }) {
  /// Passed to the embedded Space, which follows `__theme` like any HF Space.
  const theme = useTheme();
  const src = `${DOCTOR_SPACE}?dataset=${repoId}&__theme=${theme}`;
  // Which address has finished loading. A new dataset or theme is a new address, so the frame
  // reloads and this reads as loading again without any reset.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loading = loadedSrc !== src;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-1 pb-2 text-xs text-fg-muted">
        <span>
          Dataset quality diagnostics &mdash; powered by{" "}
          <a
            href="https://github.com/jashshah999/lerobot-doctor"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-fg"
          >
            lerobot-doctor
          </a>
        </span>
        <a
          href={`${DOCTOR_SPACE}?dataset=${repoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-fg"
        >
          Open in new tab
        </a>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          src={src}
          title="lerobot-doctor"
          onLoad={() => setLoadedSrc(src)}
          aria-busy={loading}
          className="h-full w-full rounded-lg border border-line bg-[var(--surface-0)]"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
        {/* The Space is another server, and one that sleeps when idle: until it answers the
            frame is an empty box, which read as a broken tab. */}
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center rounded-lg border border-line bg-[var(--surface-0)]">
            <InlineLoading label="Loading lerobot-doctor…" />
            <p className="-mt-4 max-w-sm text-center text-xs text-fg-faint">
              It runs in its own Space, which can take a moment to wake up if
              nobody has used it recently.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeDatasetPath } from "@/utils/datasetSource";

/** An explicit path works even when the repository has no root dataset. */
export default function DatasetPathPicker({
  repoId,
  path = "",
}: {
  repoId: string;
  path?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(path);
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const params = new URLSearchParams();
          const normalized = normalizeDatasetPath(value);
          if (normalized) params.set("path", normalized);
          router.push(`/${repoId}/episode_0${params.size ? `?${params}` : ""}`);
          setError("");
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
      }}
    >
      <label className="flex items-center gap-2 text-fg-muted">
        Dataset directory
        <input
          aria-label="Dataset directory"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Repository root"
          className="w-44 rounded border border-line bg-[var(--surface-1)] px-2 py-1 font-mono text-fg"
        />
      </label>
      <button className="btn" type="submit">
        Open
      </button>
      {error && (
        <span role="alert" className="text-red-600 dark:text-red-300">
          {error}
        </span>
      )}
    </form>
  );
}

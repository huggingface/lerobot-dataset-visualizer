"use client";
import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { authHeaders } from "@/utils/auth";
import HfAuthButton from "@/components/hf-auth-button";
import { Spinner, ThemeToggle } from "@/components/ui";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}

const LOGO_URL =
  "https://github.com/huggingface/lerobot/raw/main/media/readme/lerobot-logo-thumbnail.png";

const HEADER_LINKS = [
  { label: "Docs", href: "https://huggingface.co/docs/lerobot" },
  { label: "GitHub", href: "https://github.com/huggingface/lerobot" },
  { label: "Discord", href: "https://discord.gg/s3KuuzsPFb" },
];

const FEATURES = [
  {
    icon: "🎞️",
    title: "Episodes",
    body: "Every camera in sync, with each joint's state and action charted alongside. Step through episodes, scrub, and share a link to any moment.",
  },
  {
    icon: "🦾",
    title: "3D Replay",
    body: "Watch the robot move from its recorded joint positions: SO-100/SO-101, OpenArm and Unitree G1.",
  },
  {
    icon: "🔍",
    title: "Quality tools",
    body: "Statistics, first/last-frame overviews, action insights and filters to find and flag bad episodes before training.",
  },
];

const EXAMPLE_DATASETS = [
  "lerobot/svla_so101_pickplace",
  "lerobot/high_quality_folding",
  "lerobot/aloha_static_cups_open",
  "imstevenpmwork/thanos_picking_power_gem",
];

function HomeInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Handle redirects with useEffect instead of direct redirect
  useEffect(() => {
    // Redirect to the first episode of the dataset if REPO_ID is defined
    if (process.env.REPO_ID) {
      const episodeN =
        process.env.EPISODES?.split(/\s+/)
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !isNaN(x))[0] ?? 0;

      router.push(`/${process.env.REPO_ID}/episode_${episodeN}`);
      return;
    }

    // sync with hf.co/spaces URL params
    if (searchParams.get("path")) {
      router.push(searchParams.get("path")!);
      return;
    }

    // legacy sync with hf.co/spaces URL params
    let redirectUrl: string | null = null;
    if (searchParams.get("dataset") && searchParams.get("episode")) {
      redirectUrl = `/${searchParams.get("dataset")}/episode_${searchParams.get("episode")}`;
    } else if (searchParams.get("dataset")) {
      redirectUrl = `/${searchParams.get("dataset")}`;
    }

    if (redirectUrl && searchParams.get("t")) {
      redirectUrl += `?t=${searchParams.get("t")}`;
    }

    if (redirectUrl) {
      router.push(redirectUrl);
      return;
    }
  }, [searchParams, router]);

  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = 1.5;
  }, []);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      setIsLoading(false);
      setHasFetched(false);
      return;
    }
    setIsLoading(true);
    setHasFetched(false);
    setShowSuggestions(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://huggingface.co/api/quicksearch?q=${encodeURIComponent(query)}&type=dataset`,
          { cache: "no-store", headers: authHeaders() },
        );
        const data = await res.json();
        const ids: string[] = (
          (data.datasets as { id: string }[] | undefined) ?? []
        ).map((d) => d.id);
        setSuggestions(ids);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
      } finally {
        setIsLoading(false);
        setHasFetched(true);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const navigate = useCallback(
    (value: string) => {
      setShowSuggestions(false);
      router.push(value);
    },
    [router],
  );

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const target =
      activeIndex >= 0 && suggestions[activeIndex]
        ? suggestions[activeIndex]
        : query.trim();
    if (target) navigate(target);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev >= suggestions.length - 1 ? 0 : prev + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-fg">
      {/* Top bar */}
      <header className="mx-auto flex max-w-6xl items-center justify-end gap-4 px-4 py-4">
        <nav className="flex items-center gap-1 text-sm text-fg-muted">
          {HEADER_LINKS.map(({ label, href }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-md px-2.5 py-1.5 transition-colors hover:bg-fill hover:text-fg sm:block"
            >
              {label}
            </a>
          ))}
          <ThemeToggle />
          <HfAuthButton variant="tab" />
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16">
        {/* Hero */}
        <section className="flex flex-col items-center pt-10 text-center md:pt-16 animate-fade-in-up">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="LeRobot" className="mb-6 h-20 md:h-24" />
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
            Dataset <span className="text-accent-fg">Visualizer</span>
          </h1>
          <p className="mt-3 max-w-xl text-base text-fg-muted md:text-lg">
            Explore any LeRobot dataset on the Hugging Face Hub: camera
            recordings, synchronized state and actions, and a 3D replay of the
            robot.
          </p>

          {/* Search form */}
          <form
            onSubmit={handleSubmit}
            className="mt-8 flex w-full max-w-xl gap-2"
          >
            <div ref={containerRef} className="relative flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
                />
              </svg>

              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => query.trim() && setShowSuggestions(true)}
                placeholder="Enter a dataset id, e.g. lerobot/pusht"
                aria-label="Dataset id"
                className="w-full rounded-lg border border-line bg-[var(--surface-1)] py-3 pl-10 pr-4 text-base text-fg shadow-sm transition-colors placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
                autoComplete="off"
              />

              {/* Suggestions dropdown */}
              {showSuggestions && (
                <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-hidden overflow-y-auto rounded-lg border border-line bg-[var(--surface-1)] text-left shadow-xl">
                  {isLoading ? (
                    <li className="flex items-center gap-2.5 px-4 py-3 text-sm text-fg-muted">
                      <Spinner />
                      Searching…
                    </li>
                  ) : suggestions.length > 0 ? (
                    suggestions.map((id, i) => (
                      <li key={id}>
                        <button
                          type="button"
                          className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                            i === activeIndex
                              ? "bg-accent/15 text-accent-fg"
                              : "text-fg-soft hover:bg-fill"
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            navigate(id);
                          }}
                          onMouseEnter={() => setActiveIndex(i)}
                        >
                          {id}
                        </button>
                      </li>
                    ))
                  ) : (
                    hasFetched && (
                      <li className="px-4 py-3 text-sm text-fg-faint">
                        No datasets found
                      </li>
                    )
                  )}
                </ul>
              )}
            </div>

            {/* Dark text on the orange: white on #ff9d00 is only 2.1:1. */}
            <button
              type="submit"
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-base font-semibold text-gray-950 shadow-sm transition-all hover:brightness-105 active:scale-95"
            >
              Go
              <kbd className="rounded bg-black/10 px-1 py-0.5 font-mono text-xs leading-tight">
                ↵
              </kbd>
            </button>
          </form>

          {/* Example Datasets */}
          <div className="mt-6 flex flex-col items-center gap-3">
            <p className="text-xs font-medium uppercase tracking-widest text-fg-faint">
              Try an example
            </p>
            <div className="flex max-w-2xl flex-wrap justify-center gap-2">
              {EXAMPLE_DATASETS.map((ds) => (
                <button
                  key={ds}
                  type="button"
                  className="rounded-full border border-line bg-[var(--surface-1)] px-3 py-1.5 text-sm text-fg-soft transition-all hover:border-accent hover:bg-accent/10 hover:text-accent-fg active:scale-95"
                  onClick={() => navigate(ds)}
                >
                  {ds}
                </button>
              ))}
            </div>
            <a
              href="https://huggingface.co/datasets?library=library:lerobot"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-accent-fg hover:underline"
            >
              Browse all LeRobot datasets on the Hub
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>

        {/* Demo */}
        <section className="mx-auto mt-12 max-w-4xl overflow-hidden rounded-xl border border-line bg-black shadow-lg">
          <video
            ref={videoRef}
            src="https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/lerobot/level2.mp4"
            autoPlay
            muted
            loop
            playsInline
            className="block aspect-video w-full object-cover"
          />
        </section>

        {/* What you can do */}
        <section className="mt-12 grid gap-4 md:grid-cols-3">
          {FEATURES.map(({ icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-line bg-[var(--surface-1)] p-5"
            >
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-lg">
                {icon}
              </div>
              <h2 className="font-semibold text-fg">{title}</h2>
              <p className="mt-1 text-sm text-fg-muted">{body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-line-subtle py-6 text-center text-sm text-fg-faint">
        Part of{" "}
        <a
          href="https://github.com/huggingface/lerobot"
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg-muted hover:text-accent-fg"
        >
          🤗 LeRobot
        </a>
        , state-of-the-art machine learning for real-world robotics.
      </footer>
    </div>
  );
}

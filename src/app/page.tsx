"use client";
import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";

declare global {
  interface Window {
    YT?: {
      Player: new (
        id: string,
        config: Record<string, unknown>,
      ) => { destroy?: () => void };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}

const EXAMPLE_DATASETS = [
  "lerobot-data-collection/level12_rac_2_2026-02-07",
  "imstevenpmwork/thanos_picking_power_gem",
  "lerobot/aloha_static_cups_open",
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

  const playerRef = useRef<{ destroy?: () => void } | null>(null);

  useEffect(() => {
    // Load YouTube IFrame API if not already present
    if (!window.YT) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
    }
    let interval: NodeJS.Timeout;
    window.onYouTubeIframeAPIReady = () => {
      if (!window.YT) return;
      playerRef.current = new window.YT.Player("yt-bg-player", {
        videoId: "Er8SPJsIYr0",
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          showinfo: 0,
          modestbranding: 1,
          rel: 0,
          loop: 1,
          fs: 0,
          playlist: "Er8SPJsIYr0",
          start: 0,
        },
        events: {
          onReady: (event: {
            target: {
              playVideo: () => void;
              mute: () => void;
              seekTo: (t: number) => void;
              getCurrentTime: () => number;
            };
          }) => {
            event.target.playVideo();
            event.target.mute();
            interval = setInterval(() => {
              const t = event.target.getCurrentTime();
              if (t >= 60) {
                event.target.seekTo(0);
              }
            }, 500);
          },
        },
      });
    };
    return () => {
      if (interval) clearInterval(interval);
      if (playerRef.current && playerRef.current.destroy)
        playerRef.current.destroy();
    };
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
          { cache: "no-store" },
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
    <div className="relative h-screen w-screen overflow-hidden">
      {/* YouTube Video Background */}
      <div className="video-background">
        <div id="yt-bg-player" />
      </div>

      {/* Gradient overlay — darker at edges, lighter at center for depth */}
      <div className="fixed inset-0 -z-0 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.35)_0%,rgba(0,0,0,0.80)_100%)]" />

      {/* Centered Content */}
      <div className="relative z-10 h-screen flex flex-col items-center justify-center text-white text-center animate-fade-in-up px-4">
        {/* Title */}
        <h1 className="text-4xl md:text-5xl font-bold mb-2 drop-shadow-lg tracking-tight">
          LeRobot{" "}
          <span className="bg-gradient-to-r from-sky-400 to-indigo-400 bg-clip-text text-transparent">
            Dataset
          </span>{" "}
          Visualizer
        </h1>

        {/* Subtitle */}
        <p className="text-white/55 text-base md:text-lg mb-8 max-w-md">
          Explore and visualize robot learning datasets from Hugging Face
        </p>

        {/* Search form */}
        <form onSubmit={handleSubmit} className="flex gap-2 justify-center">
          <div ref={containerRef} className="relative">
            {/* Search icon */}
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
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
              placeholder="Enter dataset id (e.g. lerobot/pusht)"
              className="pl-10 pr-4 py-2.5 rounded-md text-base text-white bg-white/10 backdrop-blur-sm border border-white/30 focus:outline-none focus:border-sky-400 focus:bg-white/15 w-[380px] shadow-md placeholder:text-white/40 transition-colors"
              autoComplete="off"
            />

            {/* Suggestions dropdown */}
            {showSuggestions && (
              <ul className="absolute left-0 right-0 top-full mt-1 rounded-md bg-slate-900/95 backdrop-blur-sm border border-white/10 shadow-xl overflow-hidden z-50 max-h-64 overflow-y-auto">
                {isLoading ? (
                  <li className="flex items-center gap-2.5 px-4 py-3 text-sm text-white/50">
                    <svg
                      className="animate-spin w-4 h-4 shrink-0"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v8H4z"
                      />
                    </svg>
                    Searching…
                  </li>
                ) : suggestions.length > 0 ? (
                  suggestions.map((id, i) => (
                    <li key={id}>
                      <button
                        type="button"
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                          i === activeIndex
                            ? "bg-sky-600 text-white"
                            : "text-slate-200 hover:bg-slate-700"
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
                    <li className="px-4 py-3 text-sm text-white/40">
                      No datasets found
                    </li>
                  )
                )}
              </ul>
            )}
          </div>

          <button
            type="submit"
            className="px-5 py-2.5 rounded-md bg-sky-500 text-white font-semibold text-base hover:bg-sky-400 active:scale-95 transition-all shadow-md flex items-center gap-2"
          >
            Go
            <kbd className="text-xs font-mono bg-white/20 rounded px-1 py-0.5 leading-tight">
              ↵
            </kbd>
          </button>
        </form>

        {/* Example Datasets */}
        <div className="mt-8">
          <p className="text-white/40 text-xs uppercase tracking-widest mb-3 font-medium">
            Example Datasets
          </p>
          <div className="flex flex-row flex-wrap gap-2 justify-center max-w-xl">
            {EXAMPLE_DATASETS.map((ds) => (
              <button
                key={ds}
                type="button"
                className="px-3 py-1.5 rounded-full border border-white/20 text-sm text-sky-200/80 hover:border-sky-400 hover:text-white hover:bg-sky-500/15 active:scale-95 transition-all backdrop-blur-sm"
                onClick={() => navigate(ds)}
              >
                {ds}
              </button>
            ))}
          </div>
        </div>

        {/* Explore CTA */}
        <Link
          href="/explore"
          className="inline-flex items-center gap-2 px-6 py-3 mt-8 rounded-md bg-sky-500/90 backdrop-blur-sm text-white font-semibold text-lg shadow-lg hover:bg-sky-400 active:scale-95 transition-all"
        >
          Explore Open Datasets
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
            />
          </svg>
        </Link>
      </div>
    </div>
  );
}

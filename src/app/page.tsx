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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://huggingface.co/api/quicksearch?q=${encodeURIComponent(query)}&type=dataset`,
          { cache: "no-store" },
        );
        const data = await res.json();
        const ids: string[] = (
          data.datasets as { id: string }[] | undefined ?? []
        ).map((d) => d.id);
        setSuggestions(ids);
        setShowSuggestions(ids.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
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
      {/* Overlay */}
      <div className="fixed top-0 right-0 bottom-0 left-0 bg-black/60 -z-0" />
      {/* Centered Content */}
      <div className="relative z-10 h-screen flex flex-col items-center justify-center text-white text-center">
        <h1 className="text-4xl md:text-5xl font-bold mb-6 drop-shadow-lg">
          LeRobot Dataset Tool and Visualizer
        </h1>
        <form onSubmit={handleSubmit} className="flex gap-2 justify-center mt-6">
          <div ref={containerRef} className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Enter dataset id (e.g. lerobot/pusht)"
              className="px-4 py-2.5 rounded-md text-base text-white bg-white/10 backdrop-blur-sm border border-white/40 focus:outline-none focus:border-sky-400 focus:bg-white/15 w-[380px] shadow-md placeholder:text-white/50 transition-colors"
              autoComplete="off"
            />
            {showSuggestions && (
              <ul className="absolute left-0 right-0 top-full mt-1 rounded-md bg-slate-900/95 backdrop-blur-sm border border-white/10 shadow-xl overflow-hidden z-50 max-h-64 overflow-y-auto">
                {suggestions.map((id, i) => (
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
                ))}
              </ul>
            )}
          </div>
          <button
            type="submit"
            className="px-5 py-2.5 rounded-md bg-sky-400 text-black font-semibold text-base hover:bg-sky-300 transition-colors shadow-md"
          >
            Go
          </button>
        </form>
        {/* Example Datasets */}
        <div className="mt-8">
          <div className="font-semibold mb-2 text-lg">Example Datasets:</div>
          <div className="flex flex-col gap-2 items-center">
            {[
              "lerobot-data-collection/level12_rac_2_2026-02-07",
              "imstevenpmwork/thanos_picking_power_gem_1749731584242992",
              "lerobot/aloha_static_cups_open",
            ].map((ds) => (
              <button
                key={ds}
                type="button"
                className="px-4 py-2 rounded bg-slate-700 text-sky-200 hover:bg-sky-700 hover:text-white transition-colors shadow"
                onClick={() => navigate(ds)}
              >
                {ds}
              </button>
            ))}
          </div>
        </div>

        <Link
          href="/explore"
          className="inline-block px-6 py-3 mt-8 rounded-md bg-sky-500 text-white font-semibold text-lg shadow-lg hover:bg-sky-400 transition-colors"
        >
          Explore Open Datasets
        </Link>
      </div>
    </div>
  );
}

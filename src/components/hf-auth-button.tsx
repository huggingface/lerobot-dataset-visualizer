"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/auth-context";

const SIGNIN_BADGE_URL =
  "https://huggingface.co/datasets/huggingface/badges/resolve/main/sign-in-with-huggingface-sm-dark.svg";

// `badge` — the official HF brand badge. Use as a strong invitation when the
//           auth path is itself the page's headline action.
// `ghost`  — a quiet inline cyan link, sized to the surrounding body copy.
//           Use when auth is a secondary affordance next to a primary CTA
//           (e.g. the home page's search bar).
// `tab`    — uppercase tracked text styled to match a tab strip; pairs with
//           the episode viewer's tab bar so the auth control reads as part
//           of the same register.
type Variant = "badge" | "ghost" | "tab";

interface HfAuthButtonProps {
  variant?: Variant;
}

export default function HfAuthButton({ variant = "badge" }: HfAuthButtonProps) {
  const { oauth, isAuthAvailable, signIn, signOut } = useAuth();

  // Stable slot — auth state resolves async on mount (config fetch, then
  // localStorage rehydrate), so the rendered control changes from
  // null → signed-out → signed-in. Reserve the height so the surrounding
  // layout doesn't reflow each time. h-6 matches the badge image's
  // intrinsic height and is also tall enough to contain the ghost/tab/pill
  // variants without clipping.
  if (!isAuthAvailable) {
    return <span aria-hidden className="inline-block h-6" />;
  }

  if (oauth) {
    const name =
      oauth.userInfo?.preferred_username ?? oauth.userInfo?.name ?? "signed in";
    const avatar = oauth.userInfo?.picture;
    return <SignedInMenu name={name} avatar={avatar} onSignOut={signOut} />;
  }

  if (variant === "ghost") {
    return (
      <button
        onClick={signIn}
        title="Sign in to access your private datasets"
        className="cursor-pointer inline-flex items-center h-6 gap-1.5 text-[11px] tracking-wide text-cyan-300/80 hover:text-cyan-200 transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <span aria-hidden>🤗</span>
        <span>Sign in for private datasets</span>
        <span aria-hidden className="opacity-60">
          →
        </span>
      </button>
    );
  }

  if (variant === "tab") {
    return (
      <button
        onClick={signIn}
        title="Sign in to access your private datasets"
        className="cursor-pointer inline-flex items-center h-6 gap-1.5 px-3 text-[11px] font-medium tracking-wide uppercase text-slate-400 hover:text-cyan-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <span aria-hidden>🤗</span>
        <span>Sign in</span>
      </button>
    );
  }

  return (
    <button
      onClick={signIn}
      title="Sign in with Hugging Face to access your private datasets"
      aria-label="Sign in with Hugging Face to access your private datasets"
      className="cursor-pointer inline-flex items-center h-6 rounded-md transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={SIGNIN_BADGE_URL}
        alt="Sign in with Hugging Face"
        height={24}
        className="h-6 w-auto"
      />
    </button>
  );
}

function SignedInMenu({
  name,
  avatar,
  onSignOut,
}: {
  name: string;
  avatar?: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cursor-pointer inline-flex items-center h-6 gap-1.5 panel-raised bg-[var(--surface-0)]/85 backdrop-blur px-1.5 text-[11px] text-slate-300 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
        title={`Signed in as ${name}`}
      >
        {avatar && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatar}
            alt=""
            width={20}
            height={20}
            className="rounded-full ring-1 ring-white/10"
          />
        )}
        <span className="tabular max-w-[8rem] truncate">{name}</span>
        <svg
          aria-hidden
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className={`text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 min-w-[10rem] panel-raised bg-[var(--surface-1)]/98 backdrop-blur shadow-xl p-1 z-50 text-[11px]"
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="cursor-pointer w-full text-left px-2 py-1.5 rounded text-slate-300 hover:bg-white/5 hover:text-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

"use client";

import React from "react";
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
    return (
      <div className="inline-flex items-center h-6 gap-1.5 panel-raised bg-[var(--surface-0)]/85 backdrop-blur px-1.5 text-[11px] text-slate-300">
        {avatar && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatar}
            alt=""
            width={14}
            height={14}
            className="rounded-full"
          />
        )}
        <span className="tabular max-w-[8rem] truncate">{name}</span>
        <button
          onClick={signOut}
          className="cursor-pointer rounded px-1 text-[9px] uppercase tracking-wide text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
          title="Sign out of Hugging Face"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (variant === "ghost") {
    return (
      <button
        onClick={signIn}
        title="Sign in to access your private datasets"
        className="cursor-pointer inline-flex items-center h-6 gap-1.5 text-[11px] tracking-wide text-cyan-300/80 hover:text-cyan-200 transition-colors"
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
        className="cursor-pointer inline-flex items-center h-6 gap-1.5 px-3 text-[11px] font-medium tracking-wide uppercase text-slate-400 hover:text-cyan-300 transition-colors"
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
      className="cursor-pointer inline-flex items-center h-6 rounded-md transition-opacity hover:opacity-90"
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

"use client";

import React from "react";
import { useAuth } from "@/context/auth-context";

const SIGNIN_BADGE_URL =
  "https://huggingface.co/datasets/huggingface/badges/resolve/main/sign-in-with-huggingface-md-dark.svg";

export default function HfAuthButton() {
  const { oauth, isAuthAvailable, signIn, signOut } = useAuth();

  if (!isAuthAvailable) return null;

  if (oauth) {
    const name =
      oauth.userInfo?.preferred_username ?? oauth.userInfo?.name ?? "signed in";
    const avatar = oauth.userInfo?.picture;
    return (
      <div className="flex items-center gap-2 panel-raised bg-[var(--surface-0)]/85 backdrop-blur px-2 py-1 text-xs text-slate-300">
        {avatar && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatar}
            alt=""
            width={18}
            height={18}
            className="rounded-full"
          />
        )}
        <span className="tabular max-w-[10rem] truncate">{name}</span>
        <button
          onClick={signOut}
          className="rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
          title="Sign out of Hugging Face"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={signIn}
      title="Sign in to access your private datasets"
      className="flex items-center gap-2 rounded-md transition-opacity hover:opacity-90"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={SIGNIN_BADGE_URL}
        alt="Sign in with Hugging Face"
        height={32}
        className="h-8 w-auto"
      />
      <span className="text-xs text-slate-300">to access private datasets</span>
    </button>
  );
}

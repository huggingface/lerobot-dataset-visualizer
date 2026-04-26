"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import {
  oauthLoginUrl,
  oauthHandleRedirectIfPresent,
  type OAuthResult,
} from "@huggingface/hub";
import { AUTH_STORAGE_KEY } from "@/utils/auth";

interface OAuthAppConfig {
  clientId: string;
  scopes: string;
}

interface AuthContextValue {
  oauth: OAuthResult | null;
  // Whether OAuth is configured for this deployment. Determined by hitting
  // /api/auth/config — the server reads OAUTH_CLIENT_ID from its env, which
  // HF Spaces injects when `hf_oauth: true` is set in the README. When
  // unconfigured, the button hides itself.
  isAuthAvailable: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  oauth: null,
  isAuthAvailable: false,
  signIn: async () => {},
  signOut: () => {},
});

// Mirror the access token into an HttpOnly cookie so the same-origin
// /api/proxy route can attach it to <video> requests, which can't carry an
// Authorization header from JS.
async function setSessionCookie(accessToken: string): Promise<void> {
  try {
    await fetch("/api/auth/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    console.error("Failed to set session cookie", err);
  }
}

async function clearSessionCookie(): Promise<void> {
  try {
    await fetch("/api/auth/session", { method: "DELETE" });
  } catch (err) {
    console.error("Failed to clear session cookie", err);
  }
}

function isExpired(result: OAuthResult): boolean {
  const exp = result.accessTokenExpiresAt;
  if (!exp) return false;
  const expDate = exp instanceof Date ? exp : new Date(exp);
  return expDate.getTime() <= Date.now();
}

async function fetchOAuthConfig(): Promise<OAuthAppConfig | null> {
  try {
    const res = await fetch("/api/auth/config");
    if (!res.ok) return null;
    const data = (await res.json()) as
      | { enabled: false }
      | { enabled: true; clientId: string; scopes: string };
    if (!data.enabled) return null;
    return { clientId: data.clientId, scopes: data.scopes };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [oauth, setOauth] = useState<OAuthResult | null>(null);
  const [config, setConfig] = useState<OAuthAppConfig | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchOAuthConfig().then((cfg) => {
      if (cancelled || !cfg) return;
      setConfig(cfg);

      const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as OAuthResult;
          if (isExpired(parsed)) {
            window.localStorage.removeItem(AUTH_STORAGE_KEY);
            clearSessionCookie();
          } else {
            setOauth(parsed);
            setSessionCookie(parsed.accessToken);
            return;
          }
        } catch {
          window.localStorage.removeItem(AUTH_STORAGE_KEY);
        }
      }

      oauthHandleRedirectIfPresent()
        .then((result) => {
          if (cancelled || !result) return;
          window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(result));
          setOauth(result);
          setSessionCookie(result.accessToken);
        })
        .catch((err) => {
          console.error("OAuth redirect handling failed", err);
        });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!config) return;
    const url = await oauthLoginUrl({
      clientId: config.clientId,
      scopes: config.scopes,
    });
    window.location.href = url + "&prompt=consent";
  }, [config]);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    setOauth(null);
    clearSessionCookie();
    // Strip ?code=... left in the URL by the OAuth redirect, if any.
    const cleanUrl = window.location.href.replace(/\?.*$/, "");
    if (cleanUrl !== window.location.href) {
      window.history.replaceState(null, "", cleanUrl);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        oauth,
        isAuthAvailable: !!config,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

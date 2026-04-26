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

interface HfSpaceVariables {
  OAUTH_CLIENT_ID?: string;
  OAUTH_SCOPES?: string;
}

interface HfWindow extends Window {
  huggingface?: { variables?: HfSpaceVariables };
}

interface AuthContextValue {
  oauth: OAuthResult | null;
  // Whether OAuth is configured for this deployment (i.e. running on an HF
  // Space with hf_oauth enabled). When false, the button hides itself.
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [oauth, setOauth] = useState<OAuthResult | null>(null);
  const [isAuthAvailable, setIsAuthAvailable] = useState(false);

  useEffect(() => {
    const w = window as HfWindow;
    const available = !!w.huggingface?.variables?.OAUTH_CLIENT_ID;
    setIsAuthAvailable(available);
    if (!available) return;

    const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      try {
        setOauth(JSON.parse(stored) as OAuthResult);
        return;
      } catch {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      }
    }

    oauthHandleRedirectIfPresent()
      .then((result) => {
        if (result) {
          window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(result));
          setOauth(result);
        }
      })
      .catch((err) => {
        console.error("OAuth redirect handling failed", err);
      });
  }, []);

  const signIn = useCallback(async () => {
    const w = window as HfWindow;
    const scopes = w.huggingface?.variables?.OAUTH_SCOPES;
    const url = await oauthLoginUrl(scopes ? { scopes } : {});
    window.location.href = url + "&prompt=consent";
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    setOauth(null);
    // Strip ?code=... left in the URL by the OAuth redirect, if any.
    const cleanUrl = window.location.href.replace(/\?.*$/, "");
    if (cleanUrl !== window.location.href) {
      window.history.replaceState(null, "", cleanUrl);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ oauth, isAuthAvailable, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

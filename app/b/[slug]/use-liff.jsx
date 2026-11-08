"use client";

import { useEffect, useState } from "react";

// LINE's LIFF SDK on the customer pages: inside LINE (or logged in to LINE in a browser) we get an ID
// token the server checks with LINE (who the customer is) and their display name. Outside LINE the
// page still works; login() sends the customer to LINE's login and back.
//
// LINE's own in-app browser (a link tapped in a chat, not the LIFF URL) is neither: liff.login() there
// says "logged in" but the page does not get the session back. So inside LINE, login() reopens this
// same page through the LIFF URL (liff.line.me/<id>/<path after /b>, as the LINE cards link it), where
// LINE tells the page who the customer is straight away.
export function liffUrlFor(liffId, { pathname, search = "" }) {
  const rest = String(pathname || "").replace(/^\/b(\/|$)/, "");
  return `https://liff.line.me/${liffId}/${rest}${search}`;
}

export const inLineApp = (userAgent) => /\bLine\//i.test(String(userAgent || ""));

export function useLiff(liffId) {
  const [liff, setLiff] = useState({ ready: !liffId, idToken: null, name: "", login: null });
  useEffect(() => {
    if (!liffId) return;
    let cancelled = false;
    const login = inLineApp(window.navigator.userAgent)
      ? () => window.location.assign(liffUrlFor(liffId, window.location))
      : () => window.liff?.login({ redirectUri: window.location.href });
    const script = document.createElement("script");
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.onload = async () => {
      try {
        await window.liff.init({ liffId });
        if (!window.liff.isInClient() && !window.liff.isLoggedIn()) {
          if (!cancelled) setLiff({ ready: true, idToken: null, name: "", login });
          return;
        }
        if (!window.liff.isLoggedIn()) {
          window.liff.login();
          return;
        }
        const profile = await window.liff.getProfile().catch(() => null);
        if (!cancelled) setLiff({
            ready: true,
            idToken: window.liff.getIDToken(),
            name: profile?.displayName ?? "",
            // LINE's profile picture (https, on LINE's own host) for the member card on the booking page
            pictureUrl: typeof profile?.pictureUrl === "string" && profile.pictureUrl.startsWith("https://") ? profile.pictureUrl : null,
            login
          });
      } catch {
        if (!cancelled) setLiff({ ready: true, idToken: null, name: "", login: null });
      }
    };
    script.onerror = () => !cancelled && setLiff({ ready: true, idToken: null, name: "", login: null });
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [liffId]);
  return liff;
}

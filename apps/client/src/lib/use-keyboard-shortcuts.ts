import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;

      if (mod && e.key === "k") {
        e.preventDefault();
        navigate("/search");
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
          input?.focus();
        }, 100);
        return;
      }

      if (isInput) return;

      if (e.key === "g") {
        const next = waitForSecondKey();
        if (next) e.preventDefault();
      }
    }

    let pendingG = false;
    let pendingTimeout: ReturnType<typeof setTimeout> | undefined;

    function waitForSecondKey(): boolean {
      if (pendingG) return false;
      pendingG = true;
      pendingTimeout = setTimeout(() => { pendingG = false; }, 500);

      function secondKey(e2: KeyboardEvent) {
        if (!pendingG) return;
        pendingG = false;
        clearTimeout(pendingTimeout);
        window.removeEventListener("keydown", secondKey);
        const routes: Record<string, string> = { i: "/inbox", d: "/documents", s: "/search", c: "/chat", t: "/settings", j: "/jobs" };
        const route = routes[e2.key];
        if (route) { e2.preventDefault(); navigate(route); }
      }

      window.addEventListener("keydown", secondKey, { once: true });
      return true;
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);
}

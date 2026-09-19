import { useEffect, useState } from "react";

// A table and a card list are different markup, not the same markup restyled, so a page
// picks one at a time instead of rendering both and hiding one with CSS. That keeps a
// bulk action button, or a filter control, from existing twice in the DOM at once.

function readMatches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

// Tailwind's md breakpoint: 768px and up is desktop, below it is the phone layout.
const BELOW_MD_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  return useMediaQuery(BELOW_MD_QUERY);
}

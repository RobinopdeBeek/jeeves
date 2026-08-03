import { useEffect, useState } from "react";

const MD_QUERY = "(min-width: 768px)";

/** True at Tailwind `md` and up (desktop chat rail). */
export function useIsMd(): boolean {
  const [isMd, setIsMd] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(MD_QUERY).matches : true,
  );
  useEffect(() => {
    const mq = window.matchMedia(MD_QUERY);
    const onChange = () => setIsMd(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMd;
}

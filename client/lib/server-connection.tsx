import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ServerBanner = "hidden" | "offline" | "back-online";

const RECOVERY_MS = 3_500;
const POLL_OFFLINE_MS = 2_000;
const POLL_ONLINE_MS = 5_000;

const ServerConnectionContext = createContext<ServerBanner>("hidden");

export function ServerConnectionProvider({ children }: { children: ReactNode }) {
  const [banner, setBanner] = useState<ServerBanner>("hidden");
  const wasOfflineRef = useRef(false);
  const bannerRef = useRef<ServerBanner>("hidden");
  const recoveryUntilRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    bannerRef.current = banner;
  }, [banner]);

  useEffect(() => {
    let cancelled = false;

    function inRecoveryGrace(): boolean {
      return Date.now() < recoveryUntilRef.current;
    }

    function setBannerState(next: ServerBanner): void {
      bannerRef.current = next;
      setBanner(next);
    }

    function scheduleRecoveryHide(): void {
      clearTimeout(hideTimerRef.current);
      const remaining = recoveryUntilRef.current - Date.now();
      if (remaining <= 0) {
        recoveryUntilRef.current = 0;
        setBannerState("hidden");
        return;
      }
      hideTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        if (Date.now() >= recoveryUntilRef.current) {
          recoveryUntilRef.current = 0;
          setBannerState("hidden");
        } else {
          scheduleRecoveryHide();
        }
      }, remaining);
    }

    function showRecovery(): void {
      wasOfflineRef.current = false;
      recoveryUntilRef.current = Date.now() + RECOVERY_MS;
      setBannerState("back-online");
      scheduleRecoveryHide();
    }

    async function ping(): Promise<void> {
      try {
        const res = await fetch("/api/project", { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(String(res.status));
        if (cancelled) return;

        if (inRecoveryGrace()) return;
        if (wasOfflineRef.current || bannerRef.current === "offline") {
          showRecovery();
        }
      } catch {
        if (cancelled) return;
        if (inRecoveryGrace()) return;
        clearTimeout(hideTimerRef.current);
        recoveryUntilRef.current = 0;
        wasOfflineRef.current = true;
        setBannerState("offline");
      }
    }

    function scheduleNext(delayMs: number): void {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(() => {
        void ping().finally(() => {
          if (!cancelled) {
            scheduleNext(wasOfflineRef.current ? POLL_OFFLINE_MS : POLL_ONLINE_MS);
          }
        });
      }, delayMs);
    }

    if (inRecoveryGrace()) scheduleRecoveryHide();

    void ping().finally(() => {
      if (!cancelled) {
        scheduleNext(wasOfflineRef.current ? POLL_OFFLINE_MS : POLL_ONLINE_MS);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(pollTimerRef.current);
      if (!inRecoveryGrace()) clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <ServerConnectionContext.Provider value={banner}>{children}</ServerConnectionContext.Provider>
  );
}

export function useServerBanner(): ServerBanner {
  return useContext(ServerConnectionContext);
}

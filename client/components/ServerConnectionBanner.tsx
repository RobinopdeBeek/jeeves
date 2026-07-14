import { cva } from "class-variance-authority";
import { useServerBanner } from "@/lib/server-connection";

const bannerVariants = cva("px-4 py-1.5 text-center text-xs font-medium", {
  variants: {
    state: {
      offline: "bg-destructive text-white",
      "back-online": "bg-pipeline-done text-white",
    },
  },
});

export function ServerConnectionBanner() {
  const banner = useServerBanner();

  if (banner === "hidden") return null;

  return (
    <div className={bannerVariants({ state: banner })} role="status">
      {banner === "offline"
        ? "Jeeves server is down"
        : "Server back up!"}
    </div>
  );
}

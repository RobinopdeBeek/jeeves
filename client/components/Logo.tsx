import { cn } from "@/lib/utils";

type LogoProps = {
  className?: string;
};

export function Logo({ className }: LogoProps) {
  return (
    <img
      src="/images/jeeves-logo.png"
      alt="Jeeves"
      className={cn("size-6 shrink-0 rounded-full object-cover", className)}
    />
  );
}

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { cn } from "@/lib/utils";

/** Read-only markdown with heading/list typography (Tailwind preflight resets defaults). */
const components: Components = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn("my-3 leading-relaxed first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "my-3 ms-5 list-disc marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "my-3 ms-5 list-decimal marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn(className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn("font-semibold", className)} {...props} />
  ),
  em: ({ className, ...props }) => (
    <em className={cn("italic", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "text-primary underline underline-offset-2 hover:text-primary/80",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-3 border-muted-foreground/20", className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "my-3 border-s-2 border-muted-foreground/30 ps-4 text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = Boolean(className?.includes("language-"));
    return (
      <code
        className={cn(
          !isBlock && "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "overflow-x-auto rounded-xl border border-border/50 bg-muted/30 p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
};

export function MarkdownBody({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

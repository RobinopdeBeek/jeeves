import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Shared class for read-only markdown and MDXEditor's contentEditable.
 * Styles live in `client/globals.css` (`.markdown-body …`).
 */
export const MARKDOWN_BODY_CLASS = "markdown-body";

/** Read-only markdown with shared heading/list typography. */
export function MarkdownBody({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn(MARKDOWN_BODY_CLASS, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconInfoCircle,
  IconLoader2,
  IconX,
  IconXboxX,
} from "@tabler/icons-react"
import { useEffect, useState, type CSSProperties, type PointerEvent } from "react"
import { toast, Toaster as Sonner, type ToasterProps } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Keep Sonner's swipe/drag from swallowing taps on toast controls. */
function keepToastControlTap(event: PointerEvent) {
  event.stopPropagation()
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to execCommand for older / restricted mobile browsers.
  }

  try {
    const input = document.createElement("textarea")
    input.value = text
    input.setAttribute("readonly", "")
    input.style.position = "fixed"
    input.style.top = "0"
    input.style.left = "0"
    input.style.opacity = "0"
    document.body.appendChild(input)
    input.focus()
    input.select()
    input.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    document.body.removeChild(input)
    return ok
  } catch {
    return false
  }
}

function ErrorToast({
  message,
  toastId,
}: {
  message: string
  toastId: string | number
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div
      className="flex w-89 items-center gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
      role="alert"
    >
      <IconAlertCircle className="shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 line-clamp-2" title={message}>
        {message}
      </p>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="touch-manipulation"
          aria-label="Copy error"
          title="Copy"
          onPointerDown={keepToastControlTap}
          onClick={() => {
            void copyToClipboard(message).then((ok) => {
              if (ok) setCopied(true)
            })
          }}
        >
          {copied ? (
            <IconCheck className="text-muted-foreground" />
          ) : (
            <IconCopy className="text-muted-foreground" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="touch-manipulation"
          aria-label="Dismiss"
          title="Dismiss"
          onPointerDown={keepToastControlTap}
          onClick={() => toast.dismiss(toastId)}
        >
          <IconX className="text-muted-foreground" />
        </Button>
      </div>
    </div>
  )
}

/** Persistent error toast: 2-line clamp, copy + dismiss. */
function toastError(message: string) {
  toast.custom(
    (toastId) => <ErrorToast message={message} toastId={toastId} />,
    { duration: Infinity },
  )
}

const Toaster = ({ className, style, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      // Stay interactive while Radix Dialog sets pointer-events:none on body.
      className={cn("toaster group pointer-events-auto", className)}
      icons={{
        success: <IconCircleCheck className="size-4" />,
        info: <IconInfoCircle className="size-4" />,
        warning: <IconAlertTriangle className="size-4" />,
        error: <IconXboxX className="size-4 text-destructive" />,
        loading: <IconLoader2 className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          ...style,
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster, toastError }

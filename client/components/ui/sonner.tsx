import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconInfoCircle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"
import {
  useEffect,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react"
import {
  toast as sonnerToast,
  Toaster as Sonner,
  type ExternalToast,
  type ToasterProps,
} from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ToastKind = "default" | "success" | "info" | "warning" | "error" | "loading"

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

function resolveToastMessage(message: (() => ReactNode) | ReactNode): string {
  if (typeof message === "function") return resolveToastMessage(message())
  if (typeof message === "string") return message
  if (typeof message === "number" || typeof message === "boolean") {
    return String(message)
  }
  return ""
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case "success":
      return <IconCircleCheck className="shrink-0" />
    case "info":
      return <IconInfoCircle className="shrink-0" />
    case "warning":
      return <IconAlertTriangle className="shrink-0" />
    case "error":
      return <IconAlertCircle className="shrink-0 text-destructive" />
    case "loading":
      return <IconLoader2 className="shrink-0 animate-spin" />
    default:
      return <IconInfoCircle className="shrink-0" />
  }
}

function AppToast({
  kind,
  message,
  toastId,
}: {
  kind: ToastKind
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
      role={kind === "error" ? "alert" : "status"}
    >
      <ToastIcon kind={kind} />
      <p className="min-w-0 flex-1 line-clamp-2" title={message}>
        {message}
      </p>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="touch-manipulation"
          aria-label="Copy"
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
          onClick={() => sonnerToast.dismiss(toastId)}
        >
          <IconX className="text-muted-foreground" />
        </Button>
      </div>
    </div>
  )
}

/** Persistent toast: 2-line clamp, copy + dismiss. Icon varies by kind. */
function showToast(
  kind: ToastKind,
  message: (() => ReactNode) | ReactNode,
  data?: ExternalToast,
) {
  const text = resolveToastMessage(message)
  return sonnerToast.custom(
    (toastId) => <AppToast kind={kind} message={text} toastId={toastId} />,
    { duration: Infinity, ...data },
  )
}

const toast = Object.assign(
  (message: Parameters<typeof sonnerToast>[0], data?: ExternalToast) =>
    showToast("default", message, data),
  sonnerToast,
  {
    success: (
      message: (() => ReactNode) | ReactNode,
      data?: ExternalToast,
    ) => showToast("success", message, data),
    info: (message: (() => ReactNode) | ReactNode, data?: ExternalToast) =>
      showToast("info", message, data),
    warning: (
      message: (() => ReactNode) | ReactNode,
      data?: ExternalToast,
    ) => showToast("warning", message, data),
    error: (message: (() => ReactNode) | ReactNode, data?: ExternalToast) =>
      showToast("error", message, data),
    message: (
      message: (() => ReactNode) | ReactNode,
      data?: ExternalToast,
    ) => showToast("default", message, data),
    loading: (
      message: (() => ReactNode) | ReactNode,
      data?: ExternalToast,
    ) => showToast("loading", message, data),
  },
)

const Toaster = ({ className, style, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      // Stay interactive while Radix Dialog sets pointer-events:none on body.
      className={cn("toaster group pointer-events-auto", className)}
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

export { Toaster, toast }

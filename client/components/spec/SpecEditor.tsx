import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  DiffSourceToggleWrapper,
  Separator,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import {
  Component,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Textarea } from "@/components/ui/textarea";

type SpecEditorProps = {
  markdown: string;
  readOnly: boolean;
  onChange: (markdown: string) => void;
};

export type SpecEditorHandle = {
  setMarkdown: (markdown: string) => void;
};

function SourceFallback({
  markdown,
  readOnly,
  onChange,
  notice,
}: SpecEditorProps & { notice?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
      <Textarea
        className="min-h-80 flex-1 resize-none font-mono text-sm leading-relaxed"
        value={markdown}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Spec markdown source"
      />
    </div>
  );
}

class EditorErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * MDXEditor wrapper. Falls back to a plain textarea (source mode) when
 * imperfect AI markdown blows up the rich editor.
 */
export const SpecEditor = forwardRef<SpecEditorHandle, SpecEditorProps>(
  function SpecEditor({ markdown, readOnly, onChange }, ref) {
    const editorRef = useRef<MDXEditorMethods>(null);
    const [sourceFallback, setSourceFallback] = useState(false);
    const seededRef = useRef(false);

    useImperativeHandle(ref, () => ({
      setMarkdown(next: string) {
        if (sourceFallback) return;
        try {
          editorRef.current?.setMarkdown(next);
        } catch {
          setSourceFallback(true);
        }
      },
    }));

    useEffect(() => {
      setSourceFallback(false);
      seededRef.current = false;
    }, [readOnly]);

    useEffect(() => {
      if (sourceFallback || seededRef.current) return;
      try {
        editorRef.current?.setMarkdown(markdown);
        seededRef.current = true;
      } catch {
        setSourceFallback(true);
      }
    }, [markdown, sourceFallback]);

    if (sourceFallback) {
      return (
        <SourceFallback
          markdown={markdown}
          readOnly={readOnly}
          onChange={onChange}
          notice="Rich editor could not load this markdown; editing in source mode."
        />
      );
    }

    return (
      <div className="min-h-0 flex-1 overflow-auto rounded-md border [&_.mdxeditor]:min-h-80">
        <EditorErrorBoundary onError={() => setSourceFallback(true)}>
          <MDXEditor
            ref={editorRef}
            markdown={markdown}
            readOnly={readOnly}
            onChange={onChange}
            onError={() => setSourceFallback(true)}
            plugins={[
              headingsPlugin(),
              listsPlugin(),
              quotePlugin(),
              thematicBreakPlugin(),
              markdownShortcutPlugin(),
              linkPlugin(),
              diffSourcePlugin({ viewMode: "rich-text" }),
              toolbarPlugin({
                toolbarContents: () =>
                  readOnly ? null : (
                    <DiffSourceToggleWrapper>
                      <UndoRedo />
                      <Separator />
                      <BoldItalicUnderlineToggles />
                      <Separator />
                      <ListsToggle />
                      <Separator />
                      <BlockTypeSelect />
                    </DiffSourceToggleWrapper>
                  ),
              }),
            ]}
          />
        </EditorErrorBoundary>
      </div>
    );
  },
);

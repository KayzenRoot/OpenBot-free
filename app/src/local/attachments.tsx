import { IconFile, IconPaperclip, IconX } from "@tabler/icons-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { conversationPath, json, localApiPath, request } from "./api";

type Attachment = { id: string; filename: string; size: number };

const maximumAttachmentBytes = 8 * 1024 * 1024;

export function ComposerAttachments({
  conversationId,
  disabled,
  conversationForUpload,
  onError,
  children,
}: {
  conversationId: string | null;
  disabled: boolean;
  conversationForUpload: () => Promise<string>;
  onError: (failure: unknown) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const changing = useRef(false);
  const revisions = useRef(new Map<string, number>());
  const [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [busy, setBusy] = useState(false);

  const mark = useCallback((id: string) => {
    const revision = (revisions.current.get(id) ?? 0) + 1;
    revisions.current.set(id, revision);
    return revision;
  }, []);

  const refresh = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const revision = mark(id);
      try {
        const { attachments } = await json<{ attachments: Attachment[] }>(
          `${conversationPath(id)}/attachments`,
          { signal },
        );
        if (!signal?.aborted && revisions.current.get(id) === revision) {
          setFiles((current) => ({ ...current, [id]: attachments }));
        }
      } catch (failure) {
        if (!signal?.aborted) onError(failure);
      }
    },
    [mark, onError],
  );

  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    void refresh(conversationId, controller.signal);
    return () => controller.abort();
  }, [conversationId, refresh]);

  async function change(run: () => Promise<void>) {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    try {
      await run();
    } catch (failure) {
      onError(failure);
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  async function add(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    await change(async () => {
      if (file.size > maximumAttachmentBytes) {
        throw new Error("O arquivo deve ter até 8 MB.");
      }
      const id = await conversationForUpload();
      const body = new FormData();
      body.set("file", file);
      const { attachment } = await json<{ attachment: Attachment }>(
        `${conversationPath(id)}/attachments`,
        { method: "POST", body },
      );
      mark(id);
      setFiles((current) => ({
        ...current,
        [id]: [...(current[id] ?? []), attachment],
      }));
      await refresh(id);
    });
  }

  async function remove(id: string, attachment: Attachment) {
    await change(async () => {
      await request(
        `${conversationPath(id)}/attachments/${encodeURIComponent(attachment.id)}`,
        { method: "DELETE" },
      );
      mark(id);
      setFiles((current) => ({
        ...current,
        [id]: (current[id] ?? []).filter((file) => file.id !== attachment.id),
      }));
    });
  }

  const attachments = conversationId ? (files[conversationId] ?? []) : [];
  return (
    <>
      {conversationId && attachments.length > 0 && (
        <ul
          className="composer-attachment-list"
          aria-label="Arquivos da conversa"
        >
          {attachments.map((file) => (
            <li key={file.id}>
              <a
                href={localApiPath(
                  `${conversationPath(conversationId)}/attachments/${encodeURIComponent(file.id)}`,
                )}
                download={file.filename}
                title={file.filename}
              >
                <IconFile aria-hidden="true" />
                <span>{file.filename}</span>
              </a>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={`Remover ${file.filename}`}
                onClick={() => void remove(conversationId, file)}
              >
                <IconX aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-controls">
        <input
          type="file"
          ref={input}
          hidden
          onChange={(event) => void add(event)}
        />
        <Button
          className="composer-upload"
          type="button"
          variant="ghost"
          size="icon-lg"
          disabled={disabled || busy}
          aria-label="Anexar arquivo"
          title="Anexar arquivo à conversa"
          onClick={() => input.current?.click()}
        >
          <IconPaperclip aria-hidden="true" />
        </Button>
        {busy && (
          <span role="status" className="composer-upload-status">
            Atualizando arquivos…
          </span>
        )}
        {children}
      </div>
    </>
  );
}

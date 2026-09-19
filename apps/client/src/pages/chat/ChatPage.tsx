import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, MessagesSquare, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { chatApi, type ChatMessage, type ChatSession, type Citation } from "@/lib/chat-api";
import { formatDate } from "@/lib/format";
import { storageApi } from "@/lib/storage-api";
import { useIsMobile } from "@/lib/use-media-query";

type UiMessage = ChatMessage & { streaming?: boolean };

// Parses one SSE event block ("event: name\ndata: line1\ndata: line2") into its
// event name and reassembled data. Blocks with no event line default to "message",
// matching the SSE spec, though the chat stream always sends an explicit event name.
function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function sortByRecent(sessions: ChatSession[]) {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function CitationBadges({
  citations,
  messageId,
  otherStorageLabel,
}: {
  citations: Citation[];
  messageId: string;
  otherStorageLabel: (storageDriver: string) => string | null;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex !== null ? citations[openIndex] : null;
  const openLabel = open ? otherStorageLabel(open.storageDriver) : null;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-1">
        {citations.map((_citation, index) => (
          <button
            key={`${messageId}-${index}`}
            type="button"
            onClick={() => setOpenIndex(openIndex === index ? null : index)}
            className={`h-5 w-5 rounded-full text-xs font-medium ${
              openIndex === index ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground hover:bg-muted"
            }`}
          >
            {index + 1}
          </button>
        ))}
      </div>
      {open && (
        <div className="max-w-md rounded-[1.25rem] bg-secondary p-3 text-xs">
          <p className="text-muted-foreground">{open.chunkText}</p>
          <div className="mt-1 flex items-center gap-2">
            <Link to={`/documents/${open.documentId}`} className="font-medium underline-offset-2 hover:underline">
              {open.documentName}
            </Link>
            {openLabel && <Badge variant="neutral">{openLabel}</Badge>}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  otherStorageLabel,
}: {
  message: UiMessage;
  otherStorageLabel: (storageDriver: string) => string | null;
}) {
  const isUser = message.role === "user";
  const isEmpty = message.streaming && message.content.length === 0;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] rounded-[1.5rem] px-4 py-3 text-sm ${isUser ? "bg-primary/10" : "bg-card"}`}>
        {isEmpty ? (
          <span className="flex items-center gap-1" aria-label="Generating a response">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
          </span>
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}
        {message.error && <p className="mt-2 text-xs text-destructive">{message.error}</p>}
        {message.citations && message.citations.length > 0 && (
          <CitationBadges citations={message.citations} messageId={message.id} otherStorageLabel={otherStorageLabel} />
        )}
      </div>
    </div>
  );
}

function SessionListItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
      className={`cursor-pointer ${active ? "ring-2 ring-primary" : ""}`}
    >
      <CardContent className="flex items-center justify-between gap-2 py-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{session.title ?? "New chat"}</p>
          <p className="text-xs text-muted-foreground">{formatDate(session.updatedAt)}</p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Delete chat"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

// One title-and-timestamp row rather than the desktop's rounded Card: inside a sheet
// that is already its own scrollable surface, a dozen cards each the height of a phone
// row would push the list itself off screen. This is the same session data, the same
// delete action, sized to be scanned as a list instead of a stack of tiles.
function CompactSessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
      className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-2xl px-3 ${
        active ? "bg-primary/10" : "hover:bg-muted"
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{session.title ?? "New chat"}</p>
        <p className="text-xs text-muted-foreground">{formatDate(session.updatedAt)}</p>
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Delete chat"
        className="h-11 w-11 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ConversationEmptyState({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground ${className}`}>
      <MessageCircle className="h-8 w-8" />
      <p>Start a new chat to ask questions about your documents.</p>
    </div>
  );
}

function MessageThread({
  messages,
  otherStorageLabel,
  className,
}: {
  messages: UiMessage[];
  otherStorageLabel: (storageDriver: string) => string | null;
  className: string;
}) {
  return (
    <div className={className}>
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ask a question about your documents.</p>
      ) : (
        messages.map((message) => <MessageBubble key={message.id} message={message} otherStorageLabel={otherStorageLabel} />)
      )}
    </div>
  );
}

function Composer({
  input,
  onInputChange,
  sending,
  onSubmit,
  formClassName,
  inputClassName = "flex-1",
  sendButtonClassName = "",
}: {
  input: string;
  onInputChange: (value: string) => void;
  sending: boolean;
  onSubmit: () => void;
  formClassName: string;
  inputClassName?: string;
  sendButtonClassName?: string;
}) {
  return (
    <form
      className={formClassName}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Input
        placeholder="Ask about your documents..."
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        disabled={sending}
        className={inputClassName}
      />
      <Button type="submit" disabled={sending || input.trim().length === 0} className={sendButtonClassName}>
        Send
      </Button>
    </form>
  );
}

function DeleteSessionDialog({
  deleting,
  onCancel,
  onConfirm,
  pending,
}: {
  deleting: ChatSession | null;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={deleting !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this chat?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This deletes &quot;{deleting?.title ?? "New chat"}&quot; and its messages. This cannot be undone.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState<ChatSession | null>(null);

  const { data: sessions = [] } = useQuery({ queryKey: ["chat", "sessions"], queryFn: chatApi.listSessions });
  const { data: storageDrivers = [] } = useQuery({ queryKey: ["storage-drivers"], queryFn: () => storageApi.list() });
  const activeStorageId = storageDrivers.find((d) => d.active)?.id ?? null;
  // Chat sees every storage too, so a citation for a document held elsewhere still shows
  // up. The badge is what tells the user why they cannot open it from here.
  function otherStorageLabel(storageDriver: string): string | null {
    if (storageDrivers.length === 0 || storageDriver === activeStorageId) return null;
    return storageDrivers.find((d) => d.id === storageDriver)?.label ?? storageDriver;
  }

  const { data: sessionData } = useQuery({
    queryKey: ["chat", "session", selectedId],
    queryFn: () => chatApi.getSession(selectedId as string),
    enabled: selectedId !== null,
  });

  useEffect(() => {
    if (selectedId === null) {
      setMessages([]);
      return;
    }
    if (sessionData && sessionData.session.id === selectedId) {
      setMessages(sessionData.messages);
    }
  }, [selectedId, sessionData]);

  const createSession = useMutation({
    mutationFn: () => chatApi.createSession(),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
      setSelectedId(session.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => chatApi.deleteSession(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
      if (selectedId === id) setSelectedId(null);
      setDeleting(null);
      toast.success("Chat deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function sendMessage() {
    const content = input.trim();
    if (!content || !selectedId || sending) return;

    setInput("");
    setSending(true);

    const userMessage: UiMessage = {
      id: `local-user-${Date.now()}`,
      sessionId: selectedId,
      role: "user",
      content,
      citations: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    const assistantId = `local-assistant-${Date.now()}`;
    const assistantMessage: UiMessage = {
      id: assistantId,
      sessionId: selectedId,
      role: "assistant",
      content: "",
      citations: null,
      error: null,
      createdAt: new Date().toISOString(),
      streaming: true,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    const appendToken = (text: string) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + text } : m)));
    };
    const finalize = (patch: Partial<UiMessage>) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch, streaming: false } : m)));
    };

    try {
      const res = await fetch(`/api/chat/sessions/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        credentials: "include",
      });
      if (!res.ok || !res.body) throw new Error("Failed to send message");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      while (!settled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            if (parsed.event === "token") {
              appendToken(parsed.data);
            } else if (parsed.event === "done") {
              const payload = JSON.parse(parsed.data) as { citations: Citation[] };
              finalize({ citations: payload.citations.length > 0 ? payload.citations : null });
              settled = true;
            } else if (parsed.event === "error") {
              const payload = JSON.parse(parsed.data) as { message: string };
              finalize({ error: payload.message });
              settled = true;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send message";
      finalize({ error: message });
      toast.error(message);
    } finally {
      setSending(false);
      queryClient.invalidateQueries({ queryKey: ["chat", "sessions"] });
    }
  }

  const sortedSessions = sortByRecent(sessions);
  const isMobile = useIsMobile();
  const [sessionsOpen, setSessionsOpen] = useState(false);

  function selectSession(id: string) {
    setSelectedId(id);
    setSessionsOpen(false);
  }

  // Below md the sessions list moves off the main screen entirely: the conversation
  // gets the full width, the composer sits above the safe area, and the session list
  // opens from a header button instead of sharing the screen as a second column.
  if (isMobile) {
    return (
      <div className="flex h-[calc(100dvh-9rem)] w-full min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" className="min-h-11 gap-1.5" onClick={() => setSessionsOpen(true)}>
            <MessagesSquare className="h-4 w-4" />
            Chats
          </Button>
          <Button type="button" size="sm" className="min-h-11" onClick={() => createSession.mutate()} disabled={createSession.isPending}>
            New chat
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2rem] bg-card">
          {selectedId === null ? (
            <ConversationEmptyState className="px-6" />
          ) : (
            <>
              <MessageThread messages={messages} otherStorageLabel={otherStorageLabel} className="flex-1 space-y-4 overflow-y-auto p-4" />
              <Composer
                input={input}
                onInputChange={setInput}
                sending={sending}
                onSubmit={() => void sendMessage()}
                formClassName="flex items-center gap-2 border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                inputClassName="h-11 flex-1"
                sendButtonClassName="h-11 min-w-16"
              />
            </>
          )}
        </div>

        {/* DialogContent is already a full screen sheet with its own scroll and a sticky
            header below md, and the app's usual centered card at md and up, so the
            sessions list needs no positioning of its own here. */}
        <Dialog open={sessionsOpen} onOpenChange={setSessionsOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Chats</DialogTitle>
            </DialogHeader>
            <Button
              type="button"
              className="min-h-11 w-full"
              onClick={() => {
                createSession.mutate();
                setSessionsOpen(false);
              }}
              disabled={createSession.isPending}
            >
              New chat
            </Button>
            {sortedSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No chats yet.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {sortedSessions.map((session) => (
                  <CompactSessionRow
                    key={session.id}
                    session={session}
                    active={session.id === selectedId}
                    onSelect={() => selectSession(session.id)}
                    onDelete={() => setDeleting(session)}
                  />
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>

        <DeleteSessionDialog
          deleting={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => deleting && deleteSession.mutate(deleting.id)}
          pending={deleteSession.isPending}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] gap-6">
      <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto">
        <Button type="button" onClick={() => createSession.mutate()} disabled={createSession.isPending}>
          New chat
        </Button>
        <div className="flex flex-col gap-2">
          {sortedSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No chats yet.</p>
          ) : (
            sortedSessions.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                active={session.id === selectedId}
                onSelect={() => setSelectedId(session.id)}
                onDelete={() => setDeleting(session)}
              />
            ))
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden rounded-[2rem] bg-card">
        {selectedId === null ? (
          <ConversationEmptyState />
        ) : (
          <>
            <MessageThread messages={messages} otherStorageLabel={otherStorageLabel} className="flex-1 space-y-4 overflow-y-auto p-6" />
            <Composer
              input={input}
              onInputChange={setInput}
              sending={sending}
              onSubmit={() => void sendMessage()}
              formClassName="flex items-center gap-2 border-t border-border p-4"
            />
          </>
        )}
      </div>

      <DeleteSessionDialog
        deleting={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteSession.mutate(deleting.id)}
        pending={deleteSession.isPending}
      />
    </div>
  );
}

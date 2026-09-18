import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { chatApi, type ChatMessage, type ChatSession, type Citation } from "@/lib/chat-api";
import { formatDate } from "@/lib/format";

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

function CitationBadges({ citations, messageId }: { citations: Citation[]; messageId: string }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

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
      {openIndex !== null && citations[openIndex] && (
        <div className="max-w-md rounded-[1.25rem] bg-secondary p-3 text-xs">
          <p className="text-muted-foreground">{citations[openIndex].chunkText}</p>
          <Link
            to={`/documents/${citations[openIndex].documentId}`}
            className="mt-1 inline-block font-medium underline-offset-2 hover:underline"
          >
            {citations[openIndex].documentName}
          </Link>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
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
          <CitationBadges citations={message.citations} messageId={message.id} />
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

export function ChatPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState<ChatSession | null>(null);

  const { data: sessions = [] } = useQuery({ queryKey: ["chat", "sessions"], queryFn: chatApi.listSessions });

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
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <MessageCircle className="h-8 w-8" />
            <p>Start a new chat to ask questions about your documents.</p>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto p-6">
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">Ask a question about your documents.</p>
              ) : (
                messages.map((message) => <MessageBubble key={message.id} message={message} />)
              )}
            </div>
            <form
              className="flex items-center gap-2 border-t border-border p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage();
              }}
            >
              <Input
                placeholder="Ask about your documents..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={sending}
                className="flex-1"
              />
              <Button type="submit" disabled={sending || input.trim().length === 0}>
                Send
              </Button>
            </form>
          </>
        )}
      </div>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this chat?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This deletes &quot;{deleting?.title ?? "New chat"}&quot; and its messages. This cannot be undone.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteSession.isPending}
              onClick={() => deleting && deleteSession.mutate(deleting.id)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Headphones,
  Loader2,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  adminCloseSupportConversation,
  adminGetSupportConversation,
  adminListSupportConversations,
  adminSendSupportReply,
  getMe,
  type AdminSupportConversation,
  type SupportMessage,
} from "@/lib/app-api";

export const Route = createFileRoute("/_authenticated/admin-support")({
  head: () => ({
    meta: [{ title: "Support Inbox — Sparkle Insure" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminSupportPage,
});

function AdminSupportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const { data: me, isLoading: loadingMe } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const isAdmin = !!me?.roles.includes("admin");
  const { data: inbox, isLoading: loadingInbox } = useQuery({
    queryKey: ["admin-support-inbox"],
    queryFn: adminListSupportConversations,
    enabled: isAdmin,
    refetchInterval: 5_000,
  });
  const conversations = useMemo(() => inbox?.conversations ?? [], [inbox?.conversations]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return conversations
      .filter(
        (conversation) =>
          !needle ||
          [
            conversation.memberName,
            conversation.accountId,
            conversation.email,
            conversation.latestMessage?.body,
          ].some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(needle),
          ),
      )
      .sort((a, b) => {
        const priority = (value: AdminSupportConversation) =>
          value.status === "waiting_for_admin" ? 2 : value.unreadByAdmin > 0 ? 1 : 0;
        return (
          priority(b) - priority(a) ||
          new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
        );
      });
  }, [conversations, search]);
  const {
    data: thread,
    isLoading: loadingThread,
    refetch: refetchThread,
  } = useQuery({
    queryKey: ["admin-support-thread", selectedId],
    queryFn: () => adminGetSupportConversation({ data: { conversationId: selectedId! } }),
    enabled: isAdmin && !!selectedId,
    refetchInterval: 4_000,
  });

  useEffect(() => {
    if (me && !isAdmin) navigate({ to: "/dashboard" });
  }, [isAdmin, me, navigate]);

  useEffect(() => {
    if (!selectedId && visible.length) setSelectedId(visible[0].id);
  }, [selectedId, visible]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [thread?.messages?.length]);

  async function sendReply() {
    const trimmed = reply.trim();
    if (!trimmed || !selectedId) return;
    setSending(true);
    try {
      await adminSendSupportReply({ data: { conversationId: selectedId, message: trimmed } });
      setReply("");
      await Promise.all([
        refetchThread(),
        queryClient.invalidateQueries({ queryKey: ["admin-support-inbox"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reply could not be sent");
    } finally {
      setSending(false);
    }
  }

  async function closeConversation() {
    if (
      !selectedId ||
      !confirm(
        "Close this support conversation? The member can reopen it by sending a new message.",
      )
    )
      return;
    try {
      await adminCloseSupportConversation({ data: { conversationId: selectedId } });
      await Promise.all([
        refetchThread(),
        queryClient.invalidateQueries({ queryKey: ["admin-support-inbox"] }),
      ]);
      toast.success("Support conversation closed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Conversation could not be closed");
    }
  }

  if (loadingMe || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const waitingCount = conversations.filter(
    (conversation) => conversation.status === "waiting_for_admin",
  ).length;

  return (
    <div className="min-h-screen">
      <AppHeader isAdmin />
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6 md:py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/admin">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to Admin Console
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold md:text-3xl">
            <Headphones className="h-7 w-7 text-primary" /> Support inbox
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review Mandy’s conversations and respond when a member requests human support.
          </p>
        </div>

        <div className="grid min-h-[620px] gap-4 lg:grid-cols-[340px_1fr]">
          <Card className="glass-card overflow-hidden rounded-2xl">
            <div className="border-b border-border/60 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-semibold">Conversations</span>
                {waitingCount > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                    {waitingCount} waiting
                  </span>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search members…"
                  className="pl-9"
                />
              </div>
            </div>
            <div className="max-h-[540px] overflow-y-auto">
              {loadingInbox ? (
                <div className="flex justify-center py-16">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !visible.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  No support conversations found.
                </p>
              ) : (
                visible.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => setSelectedId(conversation.id)}
                    className={`w-full border-b border-border/50 p-4 text-left transition-colors hover:bg-muted/50 ${selectedId === conversation.id ? "bg-primary/10" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{conversation.memberName}</div>
                        <div className="text-xs font-mono text-muted-foreground">
                          {conversation.accountId}
                        </div>
                      </div>
                      {conversation.unreadByAdmin > 0 && (
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                          {conversation.unreadByAdmin}
                        </span>
                      )}
                    </div>
                    <div
                      className={`mt-2 text-[11px] font-medium ${conversation.status === "waiting_for_admin" ? "text-amber-600" : conversation.status === "admin_active" ? "text-emerald-600" : "text-muted-foreground"}`}
                    >
                      {statusLabel(conversation.status)}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {conversation.latestMessage?.body ?? "No messages yet"}
                    </p>
                  </button>
                ))
              )}
            </div>
          </Card>

          <Card className="glass-card flex min-h-[620px] flex-col overflow-hidden rounded-2xl">
            {!selectedId ? (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Select a conversation to view it.
              </div>
            ) : loadingThread || !thread ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 p-4">
                  <div>
                    <div className="font-semibold">
                      {thread.conversation.member?.name ?? "Unknown member"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {thread.conversation.member?.accountId} · {thread.conversation.member?.email}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">
                      {statusLabel(thread.conversation.status)}
                    </span>
                    {thread.conversation.status !== "closed" && (
                      <Button variant="outline" size="sm" onClick={closeConversation}>
                        <CheckCircle2 className="mr-2 h-4 w-4" /> Close
                      </Button>
                    )}
                  </div>
                </div>
                <div className="max-h-[430px] flex-1 space-y-3 overflow-y-auto p-4">
                  {!thread.messages.length ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      No messages yet.
                    </p>
                  ) : (
                    thread.messages.map((message: SupportMessage) => (
                      <AdminMessageBubble key={message.id} message={message} />
                    ))
                  )}
                  <div ref={endRef} />
                </div>
                <div className="border-t border-border/60 p-4">
                  <div className="flex items-end gap-2">
                    <Textarea
                      value={reply}
                      onChange={(event) => setReply(event.target.value.slice(0, 2000))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          if (!sending) void sendReply();
                        }
                      }}
                      placeholder="Reply as Sparkle Support…"
                      className="min-h-11 max-h-32 resize-none bg-background/70"
                    />
                    <Button
                      size="icon"
                      className="h-11 w-11 shrink-0 gradient-brand text-white"
                      onClick={sendReply}
                      disabled={sending || !reply.trim()}
                      aria-label="Send reply"
                    >
                      {sending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}

function statusLabel(status: string) {
  if (status === "waiting_for_admin") return "Waiting for human";
  if (status === "admin_active") return "Human support active";
  if (status === "closed") return "Closed";
  return "Mandy handling";
}

function AdminMessageBubble({ message }: { message: SupportMessage }) {
  if (message.senderType === "system")
    return (
      <div className="mx-auto max-w-lg rounded-full bg-muted px-3 py-1.5 text-center text-xs text-muted-foreground">
        {message.body}
      </div>
    );
  const fromAdmin = message.senderType === "admin";
  const fromMandy = message.senderType === "mandy";
  return (
    <div
      className={`max-w-[88%] rounded-2xl p-3 ${fromAdmin ? "ml-auto rounded-tr-sm bg-primary text-primary-foreground" : fromMandy ? "rounded-tl-sm border border-orange-500/20 bg-orange-500/5" : "rounded-tl-sm border bg-background"}`}
    >
      {!fromAdmin && (
        <div
          className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${fromMandy ? "text-orange-600" : "text-foreground"}`}
        >
          {fromMandy ? <Bot className="h-3.5 w-3.5" /> : <UserRound className="h-3.5 w-3.5" />}
          {fromMandy ? "Mandy · automated" : "Member"}
        </div>
      )}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.body}</p>
      <div
        className={`mt-1 text-[10px] ${fromAdmin ? "text-primary-foreground/70" : "text-muted-foreground"}`}
      >
        {new Date(message.createdAt).toLocaleString("en-ZA", {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </div>
    </div>
  );
}

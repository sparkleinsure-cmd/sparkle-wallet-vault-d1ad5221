import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Headphones, Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  getMe,
  getSupportConversation,
  requestSupportHuman,
  sendSupportMessage,
  type SupportMessage,
} from "@/lib/app-api";

export const Route = createFileRoute("/_authenticated/support")({
  head: () => ({
    meta: [{ title: "Support — Sparkle Insure" }, { name: "robots", content: "noindex" }],
  }),
  component: SupportPage,
});

function SupportPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [requestingHuman, setRequestingHuman] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const { data: me, isLoading: loadingMe } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const { data: thread, isLoading } = useQuery({
    queryKey: ["support-conversation"],
    queryFn: getSupportConversation,
    enabled: !!me?.profile,
    refetchInterval: 4_000,
  });

  // Filter messages to strictly within the last 24 hours
  const now = Date.now();
  const activeMessages = (thread?.messages ?? []).filter((msg) => {
    const time = new Date(msg.createdAt).getTime();
    return Number.isFinite(time) && now - time < 24 * 60 * 60 * 1000;
  });

  const status = activeMessages.length === 0 ? "ai" : (thread?.conversation.status ?? "ai");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeMessages.length]);

  async function send() {
    const trimmed = message.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const next = await sendSupportMessage({
        data: { message: trimmed, requestId: crypto.randomUUID() },
      });
      setMessage("");
      queryClient.setQueryData(["support-conversation"], next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Your message could not be sent");
    } finally {
      setSending(false);
    }
  }

  async function requestHuman() {
    setRequestingHuman(true);
    try {
      const next = await requestSupportHuman();
      queryClient.setQueryData(["support-conversation"], next);
      toast.success("A human support agent has been requested");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Human support could not be requested");
    } finally {
      setRequestingHuman(false);
    }
  }

  if (loadingMe || !me?.profile) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const isAdmin = me.roles.includes("admin");
  const waitingForHuman = status === "waiting_for_admin";
  const humanActive = status === "admin_active";

  return (
    <div className="min-h-screen pb-10">
      <AppHeader
        isAdmin={isAdmin}
        displayName={`${me.profile.first_name} ${me.profile.surname}`}
        accountId={me.profile.account_id}
      />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 md:px-6 md:py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/dashboard">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to dashboard
          </Link>
        </Button>

        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold md:text-3xl">
            <span className="rounded-full bg-orange-500/15 p-2">
              <Bot className="h-6 w-6 text-orange-500" />
            </span>
            Chat with Mandy
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Mandy answers from Sparkle’s built-in help guide. Request a human whenever you need
            account-specific help or she does not know an answer.
          </p>
        </div>

        <Card className="glass-card overflow-hidden rounded-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {humanActive ? (
                <Headphones className="h-4 w-4 text-emerald-500" />
              ) : (
                <Sparkles className="h-4 w-4 text-orange-500" />
              )}
              {humanActive
                ? "Human support is responding"
                : waitingForHuman
                  ? "Waiting for a human support agent"
                  : "Mandy is ready to help"}
            </div>
            {!waitingForHuman && !humanActive && (
              <Button variant="outline" size="sm" onClick={requestHuman} disabled={requestingHuman}>
                {requestingHuman ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Headphones className="mr-2 h-4 w-4" />
                )}
                Talk to a human
              </Button>
            )}
          </div>

          <div className="max-h-[55vh] min-h-80 space-y-3 overflow-y-auto p-4">
            {isLoading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !activeMessages.length ? (
              <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-orange-500/20 bg-orange-500/5 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-orange-600">
                  <Bot className="h-3.5 w-3.5" /> Mandy · automated assistant
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  Hi! I’m Mandy. I can explain deposits, bank details, growth cycles, withdrawals,
                  insurance, referrals, and how to use Sparkle. How can I help?
                </p>
              </div>
            ) : (
              activeMessages.map((item) => <MessageBubble key={item.id} message={item} />)
            )}
            <div ref={endRef} />
          </div>

          {status === "ai" && !activeMessages.length && (
            <div className="flex flex-wrap gap-2 border-t border-border/40 px-4 py-3">
              {[
                "How does Sparkle Insure work?",
                "What are the deposit bank details?",
                "What are the growth cycle options?",
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-xs hover:border-primary/50 hover:bg-muted"
                  onClick={() => setMessage(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-border/60 p-4">
            <div className="flex items-end gap-2">
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value.slice(0, 2000))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!sending) void send();
                  }
                }}
                placeholder={
                  waitingForHuman ? "Add a message for the support team…" : "Ask Mandy a question…"
                }
                className="min-h-11 max-h-32 resize-none bg-background/70"
              />
              <Button
                size="icon"
                className="h-11 w-11 shrink-0 gradient-brand text-white"
                onClick={send}
                disabled={sending || !message.trim()}
                aria-label="Send message"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Mandy uses Sparkle’s built-in guide; messages are not sent to an outside AI provider.
              Do not share passwords, OTPs, card numbers, or full bank details.
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  if (message.senderType === "system") {
    return (
      <div className="mx-auto max-w-lg rounded-full bg-muted px-3 py-1.5 text-center text-xs text-muted-foreground">
        {message.body}
      </div>
    );
  }
  const mine = message.senderType === "user";
  const admin = message.senderType === "admin";
  return (
    <div
      className={`max-w-[88%] rounded-2xl p-3 ${mine ? "ml-auto rounded-tr-sm bg-primary text-primary-foreground" : admin ? "rounded-tl-sm border border-emerald-500/25 bg-emerald-500/10" : "rounded-tl-sm border border-orange-500/20 bg-orange-500/5"}`}
    >
      {!mine && (
        <div
          className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${admin ? "text-emerald-600" : "text-orange-600"}`}
        >
          {admin ? <Headphones className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
          {admin ? "Sparkle Support" : "Mandy · automated assistant"}
        </div>
      )}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.body}</p>
      <div
        className={`mt-1 text-[10px] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}
      >
        {new Date(message.createdAt).toLocaleString("en-ZA", {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </div>
    </div>
  );
}

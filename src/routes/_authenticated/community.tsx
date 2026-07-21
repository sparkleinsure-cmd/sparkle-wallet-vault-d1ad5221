import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { getMe } from "@/lib/app-api";
import { supabase } from "@/integrations/supabase/client";
import { Ban, Flag, ImagePlus, Loader2, MessageCircle, Send, X } from "lucide-react";

type CommunityMessage = {
  id: string;
  user_id: string;
  account_id: string;
  author_name: string;
  body: string;
  image_path: string | null;
  created_at: string;
};

const LAST_SEEN_KEY = "sparkle_community_last_seen_at";
const MAX_IMAGE_BYTES = 1024 * 1024;

export const Route = createFileRoute("/_authenticated/community")({
  head: () => ({ meta: [{ title: "Community - Sparkle Insure" }, { name: "robots", content: "noindex" }] }),
  component: CommunityPage,
});

function communityMessages() {
  return supabase.from("community_messages" as any);
}

function communityReports() {
  return supabase.from("community_reports" as any);
}

function communityBlocks() {
  return supabase.from("community_blocks" as any);
}

async function fetchMessages() {
  const { data, error } = await communityMessages()
    .select("id,user_id,account_id,author_name,body,image_path,created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  return ((data ?? []) as CommunityMessage[]).reverse();
}

async function signedImageMap(messages: CommunityMessage[]) {
  const pairs = await Promise.all(
    messages
      .filter((message) => !!message.image_path)
      .map(async (message) => {
        const { data } = await supabase.storage.from("community").createSignedUrl(message.image_path!, 3600);
        return [message.id, data?.signedUrl ?? ""] as const;
      }),
  );
  return Object.fromEntries(pairs);
}

function CommunityPage() {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null);
  const fetchMe = getMe;

  const { data: me, isLoading: loadingMe } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe() });
  const isAdmin = !!me?.roles.includes("admin");
  const userId = me?.profile?.id as string | undefined;

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["community-messages"],
    queryFn: fetchMessages,
    enabled: !!userId,
  });

  const { data: imageUrls = {} } = useQuery({
    queryKey: ["community-image-urls", messages.map((m) => `${m.id}:${m.image_path ?? ""}`).join("|")],
    queryFn: () => signedImageMap(messages),
    enabled: messages.some((message) => !!message.image_path),
  });

  const latestCreatedAt = useMemo(() => messages[messages.length - 1]?.created_at, [messages]);

  useEffect(() => {
    localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
    window.dispatchEvent(new Event("sparkle-community-seen"));
  }, [latestCreatedAt]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel("community-screen")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "community_messages" }, () => {
        qc.invalidateQueries({ queryKey: ["community-messages"] });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc, userId]);

  async function sendMessage() {
    const trimmed = body.trim();
    if (!trimmed && !file) return toast.error("Write a message or attach an image first.");
    if (!userId) return toast.error("Sign in again before posting.");
    if (file && file.size > MAX_IMAGE_BYTES) return toast.error("Images must be 1 MB or smaller.");
    if (file && !file.type.startsWith("image/")) return toast.error("Only image uploads are allowed.");

    setSending(true);
    try {
      let imagePath: string | null = null;
      if (file) {
        const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
        imagePath = `${userId}/${crypto.randomUUID()}.${extension}`;
        const uploaded = await supabase.storage.from("community").upload(imagePath, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });
        if (uploaded.error) throw new Error(uploaded.error.message);
      }

      const inserted = await communityMessages().insert({
        user_id: userId,
        body: trimmed,
        image_path: imagePath,
      });
      if (inserted.error) throw new Error(inserted.error.message);

      setBody("");
      setFile(null);
      qc.invalidateQueries({ queryKey: ["community-messages"] });
    } catch (error: any) {
      toast.error(error.message ?? "Unable to send message.");
    } finally {
      setSending(false);
    }
  }

  async function reportMessage(message: CommunityMessage) {
    const reason = window.prompt("Why are you reporting this message?", "Offensive or unsafe content");
    if (!reason?.trim() || !userId) return;
    setBusyMessageId(message.id);
    try {
      const { error } = await communityReports().insert({
        message_id: message.id,
        reporter_id: userId,
        reported_user_id: message.user_id,
        reason: reason.trim().slice(0, 500),
      });
      if (error) throw new Error(error.message);
      toast.success("Report sent. An administrator can review it.");
    } catch (error: any) {
      toast.error(error.message?.includes("duplicate") ? "You already reported this message." : error.message);
    } finally {
      setBusyMessageId(null);
    }
  }

  async function blockUser(message: CommunityMessage) {
    if (!userId || message.user_id === userId) return;
    if (!confirm(`Block ${message.author_name}? You will no longer see each other's community messages.`)) return;
    setBusyMessageId(message.id);
    try {
      const { error } = await communityBlocks().insert({ blocker_id: userId, blocked_id: message.user_id });
      if (error) throw new Error(error.message);
      toast.success("User blocked.");
      qc.invalidateQueries({ queryKey: ["community-messages"] });
    } catch (error: any) {
      toast.error(error.message?.includes("duplicate") ? "This user is already blocked." : error.message);
    } finally {
      setBusyMessageId(null);
    }
  }

  if (loadingMe || !me?.profile) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-16">
      <AppHeader isAdmin={isAdmin} accountId={me.profile.account_id} />
      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-6 md:py-10">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold md:text-3xl">
            <MessageCircle className="h-6 w-6 text-primary" />
            Community
          </h1>
          <p className="text-sm text-muted-foreground">
            Share ideas with registered Sparkle members. Keep it respectful; unsafe content can be reported and removed.
          </p>
        </div>

        <Card className="glass-card rounded-2xl p-4">
          <div className="space-y-3">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value.slice(0, 1000))}
              placeholder="Share an idea, question, or update..."
              className="min-h-24 resize-none bg-background/70"
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted">
                  <ImagePlus className="mr-2 h-4 w-4" />
                  Image
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] ?? null;
                      if (nextFile && nextFile.size > MAX_IMAGE_BYTES) {
                        toast.error("Images must be 1 MB or smaller.");
                        event.target.value = "";
                        return;
                      }
                      setFile(nextFile);
                    }}
                  />
                </label>
                {file && (
                  <span className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                    {file.name}
                    <button type="button" aria-label="Remove image" onClick={() => setFile(null)}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
              <Button className="gradient-brand text-white" disabled={sending} onClick={sendMessage}>
                {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send
              </Button>
            </div>
          </div>
        </Card>

        <Card className="glass-card rounded-2xl p-4">
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No community messages yet. Start the conversation.</p>
          ) : (
            <div className="space-y-3">
              {messages.map((message) => {
                const mine = message.user_id === userId;
                return (
                  <article key={message.id} className={`rounded-xl border border-border/70 bg-background/70 p-3 ${mine ? "ml-auto max-w-[92%] border-primary/30" : "max-w-[92%]"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{mine ? "You" : message.author_name}</div>
                        <div className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
                          {message.account_id || "Member"} · {new Date(message.created_at).toLocaleString()}
                        </div>
                      </div>
                      {!mine && (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2"
                            disabled={busyMessageId === message.id}
                            onClick={() => reportMessage(message)}
                          >
                            <Flag className="h-3.5 w-3.5" />
                            <span className="sr-only">Report message</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2 text-destructive hover:text-destructive"
                            disabled={busyMessageId === message.id}
                            onClick={() => blockUser(message)}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            <span className="sr-only">Block user</span>
                          </Button>
                        </div>
                      )}
                    </div>
                    {message.body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{message.body}</p>}
                    {message.image_path && imageUrls[message.id] && (
                      <img
                        src={imageUrls[message.id]}
                        alt="Community upload"
                        className="mt-3 max-h-80 rounded-lg border border-border object-contain"
                        loading="lazy"
                      />
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, ShieldCheck, Camera, RefreshCw, Upload } from "lucide-react";

export const Route = createFileRoute("/verify")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Verify your account — Sparkle Insure" }, { name: "robots", content: "noindex" }],
  }),
  component: VerifyPage,
});

function VerifyPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [captured, setCaptured] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) navigate({ to: "/auth" });
    });
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [navigate]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreaming(true);
    } catch (err: any) {
      toast.error(
        "Camera unavailable. You can upload a selfie photo instead. " + (err?.message ?? ""),
      );
    }
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      setCaptured(blob);
      setPreviewUrl(URL.createObjectURL(blob));
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStreaming(false);
    }, "image/jpeg", 0.9);
  };

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setCaptured(null);
    setPreviewUrl(null);
  };

  const onFileUpload = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Please choose an image file.");
    if (file.size > 8 * 1024 * 1024) return toast.error("Image must be under 8MB.");
    setCaptured(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const submit = async () => {
    if (!captured) return;
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const uid = sess.session?.user.id;
      if (!uid) throw new Error("Not signed in");
      const ext = captured.type.includes("png") ? "png" : "jpg";
      const path = `${uid}/selfie-${Date.now()}.${ext}`;
      const up = await supabase.storage.from("kyc").upload(path, captured, {
        upsert: true,
        contentType: captured.type || "image/jpeg",
      });
      if (up.error) throw new Error(up.error.message);
      const upd = await supabase
        .from("profiles")
        .update({ kyc_status: "verified" })
        .eq("id", uid);
      if (upd.error) throw new Error(upd.error.message);
      toast.success("Selfie verified. Welcome!");
      navigate({ to: "/dashboard" });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="glass-card w-full max-w-lg rounded-3xl p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl gradient-brand text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold">Selfie verification</h1>
            <p className="text-sm text-muted-foreground">
              Take a quick selfie so we can confirm it's you. This unlocks your wallet instantly.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border bg-muted">
            {previewUrl ? (
              <img src={previewUrl} alt="Selfie preview" className="h-full w-full object-cover" />
            ) : streaming ? (
              <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Camera className="h-10 w-10" />
                <div className="text-sm">Start your camera or upload a photo</div>
              </div>
            )}
          </div>

          {!captured && !streaming && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button onClick={startCamera} className="gradient-brand text-white">
                <Camera className="mr-2 h-4 w-4" /> Open camera
              </Button>
              <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent">
                <Upload className="mr-2 h-4 w-4" /> Upload selfie
                <input
                  type="file"
                  accept="image/*"
                  capture="user"
                  className="hidden"
                  onChange={(e) => onFileUpload(e.target.files?.[0])}
                />
              </label>
            </div>
          )}

          {streaming && (
            <Button onClick={capture} className="w-full gradient-brand text-white">
              <Camera className="mr-2 h-4 w-4" /> Capture selfie
            </Button>
          )}

          {captured && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" onClick={reset} disabled={loading}>
                <RefreshCw className="mr-2 h-4 w-4" /> Retake
              </Button>
              <Button onClick={submit} disabled={loading} className="gradient-brand text-white">
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <ShieldCheck className="mr-2 h-4 w-4" /> Submit & verify
              </Button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="mt-6 text-center text-xs text-muted-foreground underline"
          onClick={async () => {
            await supabase.auth.signOut();
            navigate({ to: "/auth" });
          }}
        >
          Sign out
        </button>
      </Card>
    </div>
  );
}
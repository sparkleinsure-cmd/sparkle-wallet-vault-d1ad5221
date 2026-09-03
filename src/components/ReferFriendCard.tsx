import { useMemo } from "react";
import { BriefcaseBusiness, Copy, Facebook, Gift, Share2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getRecruiterDashboard } from "@/lib/app-api";
import { PUBLIC_APP_ORIGIN } from "@/lib/public-url";

export function ReferFriendCard({ accountId }: { accountId: string }) {
  const { data: recruiterDashboard } = useQuery({
    queryKey: ["recruiter-dashboard"],
    queryFn: getRecruiterDashboard,
    enabled: !import.meta.env.DEV,
    retry: false,
  });
  const recruiterApproved = recruiterDashboard?.application?.status === "approved";
  const referralUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const url = new URL("/auth", PUBLIC_APP_ORIGIN);
    url.searchParams.set("mode", "signup");
    url.searchParams.set("ref", accountId);
    return url.toString();
  }, [accountId]);
  const message = `Join me on Sparkle Insure. Create your wallet using my referral link: ${referralUrl}`;
  const copy = async () => {
    await navigator.clipboard.writeText(referralUrl);
    toast.success("Referral link copied");
  };

  return (
    <section className="glass-card space-y-4 rounded-3xl p-4 md:p-6">
      <div>
        <h2 className="font-display text-lg font-semibold">Referral options</h2>
        <p className="text-sm text-muted-foreground">
          Choose casual friends-and-family sharing or apply for the recruiter programme.
        </p>
      </div>
      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-emerald-600 p-2 text-white">
            <Gift className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-display font-semibold">Friends &amp; family referral</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Earn 10% of your friend&apos;s first approved deposit. Your reward is available to
              withdraw immediately.
            </p>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={copy}
          >
            <Copy className="mr-2 h-4 w-4" /> Copy link
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label="Share referral link"
            onClick={async () => {
              if (navigator.share)
                await navigator.share({
                  title: "Join Sparkle Insure",
                  text: message,
                  url: referralUrl,
                });
              else await copy();
            }}
          >
            <Share2 className="h-4 w-4" />
          </Button>
          <Button asChild type="button" variant="outline" aria-label="Share on WhatsApp">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              WA
            </a>
          </Button>
          <Button asChild type="button" variant="outline" aria-label="Share on Facebook">
            <a
              href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(referralUrl)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Facebook className="h-4 w-4" />
            </a>
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          The bonus applies once, after the referred member&apos;s very first deposit is approved.
        </p>
      </div>
      <div className="rounded-2xl border border-violet-500/25 bg-violet-500/10 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-violet-600 p-2 text-white">
            <BriefcaseBusiness className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-display font-semibold">Permanent recruiter programme</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Apply for recruiter status, invite new members and track progress toward the monthly
              R3,000 wallet credit.
            </p>
          </div>
        </div>
        <Button
          asChild
          type="button"
          className="mt-4 w-full bg-violet-600 text-white hover:bg-violet-700"
        >
          <Link to="/recruiter">
            {recruiterApproved ? "Open recruiter's dashboard" : "Apply for recruiter program"}
          </Link>
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Opening this programme does not change how your normal referral link works.
        </p>
      </div>
    </section>
  );
}

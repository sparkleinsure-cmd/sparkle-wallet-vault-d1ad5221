import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/app-api";
import { AppHeader } from "@/components/Header";
import { AppBottomNav } from "@/components/AppBottomNav";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const profile = data?.profile;
  const displayName = profile
    ? [String(profile.first_name ?? "").trim().split(/\s+/)[0], String(profile.surname ?? "").trim()].filter(Boolean).join(" ") || "Member"
    : undefined;

  return (
    <div className="min-h-screen pb-24">
      <AppHeader isAdmin={data?.roles?.includes("admin") ?? false} displayName={displayName} accountId={profile?.account_id} />
      <Outlet />
      <AppBottomNav />
    </div>
  );
}

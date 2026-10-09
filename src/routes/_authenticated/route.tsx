import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Use the persisted session for the route gate, but don't let a stalled
    // storage refresh or auth lock block every authenticated route forever.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let sessionResult: Awaited<ReturnType<typeof supabase.auth.getSession>>;
    try {
      sessionResult = await Promise.race([
        supabase.auth.getSession(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Sign-in check timed out. Please try again.")),
            12_000,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    const { data, error } = sessionResult;
    if (error || !data.session?.user) throw redirect({ to: "/auth" });
    return { user: data.session.user };
  },
  component: () => <Outlet />,
});

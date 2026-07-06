import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Shield } from "lucide-react";

export function AppHeader({ isAdmin, accountId }: { isAdmin: boolean; accountId?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <header className="sticky top-0 z-30 border-b border-border/40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
        <Link to="/dashboard" className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-9 w-9 rounded-lg object-contain" />
          <div className="leading-tight">
            <div className="font-display text-sm font-bold text-gradient-brand">Sparkle Insure</div>
            {accountId && (
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                ID · {accountId}
              </div>
            )}
          </div>
        </Link>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link to="/admin"><Shield className="h-3.5 w-3.5" /> Admin</Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await qc.cancelQueries();
              qc.clear();
              await supabase.auth.signOut();
              navigate({ to: "/auth", replace: true });
            }}
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
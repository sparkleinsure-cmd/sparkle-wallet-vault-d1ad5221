import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Settings, Shield } from "lucide-react";

export function AppHeader({ isAdmin, displayName, accountId }: { isAdmin: boolean; displayName?: string; accountId?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  return (
    <header className="sticky top-0 z-30 border-b border-border/40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center px-4 py-2.5 md:px-6">
        <Link to="/dashboard" aria-label="Sparkle Insure dashboard">
          <img src="/logo.png" alt="Sparkle Insure" className="h-10 w-10 rounded-lg object-contain" />
        </Link>

        {displayName ? (
          <Link to="/dashboard" className="min-w-0 text-center leading-tight" aria-label="Home">
            <div className="truncate font-display text-sm font-bold sm:text-base">{displayName}</div>
            <div className="truncate text-[10px] text-muted-foreground">ID · {accountId}</div>
          </Link>
        ) : <div />}

        <div className="flex items-center justify-end gap-2">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/settings">
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </Button>

          {isAdmin && (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link to="/admin">
                <Shield className="h-3.5 w-3.5" />
                Admin
              </Link>
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await qc.cancelQueries();
              qc.clear();
              await supabase.auth.signOut();
              navigate({ to: "/auth", search: { mode: "signin" }, replace: true });
            }}
          >
            <LogOut className="h-3.5 w-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

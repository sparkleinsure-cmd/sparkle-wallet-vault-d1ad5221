import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Settings, Shield } from "lucide-react";

export function AppHeader({ isAdmin }: { isAdmin: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  return (
    <header className="sticky top-0 z-30 border-b border-border/40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
        <Link to="/dashboard" aria-label="Sparkle Insure dashboard">
          <img src="/logo.png" alt="Sparkle Insure" className="h-10 w-10 rounded-lg object-contain" />
        </Link>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/settings">
              <Settings className="h-3.5 w-3.5" />
              Settings
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
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

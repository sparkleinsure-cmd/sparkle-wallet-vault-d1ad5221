import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { MessageCircle, Shield } from "lucide-react";

export function AppHeader({ isAdmin, displayName, accountId }: { isAdmin: boolean; displayName?: string; accountId?: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 sm:grid-cols-[1fr_minmax(0,auto)_1fr] md:px-6">
        <div className="hidden sm:block" />

        {displayName ? (
          <Link to="/dashboard" className="min-w-0 text-center leading-tight" aria-label="Home">
            <div className="truncate font-display text-sm font-bold sm:text-base">{displayName}</div>
            <div className="truncate text-[10px] text-muted-foreground">ID · {accountId}</div>
          </Link>
        ) : <div />}

        <div className="flex items-center justify-end gap-1.5">
          <Button asChild variant="outline" size="sm" className="gap-1.5" title="Ask Mandy for help">
            <Link to="/support" aria-label="Help — Ask Mandy">
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              <span>Help</span>
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
        </div>
      </div>
    </header>
  );
}

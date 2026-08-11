import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { MessageCircle, Shield } from "lucide-react";

export function AppHeader({ isAdmin, displayName, accountId }: { isAdmin: boolean; displayName?: string; accountId?: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center px-4 py-2.5 md:px-6">
        <div />

        {displayName ? (
          <Link to="/dashboard" className="min-w-0 text-center leading-tight" aria-label="Home">
            <div className="truncate font-display text-sm font-bold sm:text-base">{displayName}</div>
            <div className="truncate text-[10px] text-muted-foreground">ID · {accountId}</div>
          </Link>
        ) : <div />}

        <div className="flex items-center justify-end gap-1.5">
          <Button asChild variant="outline" size="icon" className="h-8 w-8" title="Community">
            <a href="https://chat.whatsapp.com/HJEOYd4QEQQ9iCpapgC0z3?s=cl&p=a&mlu=0&ilr=0" target="_blank" rel="noopener noreferrer" aria-label="Join the Sparkle Insure WhatsApp community">
              <MessageCircle className="h-4 w-4" />
            </a>
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

import { Link } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowUpFromLine, FileText, House, UserRound } from "lucide-react";

const itemClass = "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-foreground hover:bg-muted/70";

export function AppBottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/95 px-2 pb-[max(0.5rem,var(--app-safe-bottom))] pt-2 shadow-[0_-8px_30px_-18px_color-mix(in_oklab,var(--foreground)_45%,transparent)] backdrop-blur-xl" aria-label="Account actions">
      <div className="mx-auto grid max-w-xl grid-cols-5 gap-1">
        <Link to="/dashboard" className={itemClass} activeProps={{ className: `${itemClass} bg-primary/10 text-primary` }}>
          <House className="h-4 w-4" />
          Home
        </Link>
        <a href="/dashboard?action=deposit" className={itemClass}>
          <ArrowDownToLine className="h-4 w-4" />
          Deposit
        </a>
        <a href="/dashboard?action=withdraw" className={itemClass}>
          <ArrowUpFromLine className="h-4 w-4" />
          Withdraw
        </a>
        <a href="/dashboard?action=statement" className={itemClass}>
          <FileText className="h-4 w-4" />
          Statement
        </a>
        <Link to="/settings" className={itemClass}>
          <UserRound className="h-4 w-4" />
          Profile
        </Link>
      </div>
    </nav>
  );
}

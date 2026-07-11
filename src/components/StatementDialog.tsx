import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { format } from "date-fns";
import jsPDF from "jspdf";
import { formatMoney, type Currency } from "@/lib/currency";

type Tx = {
  id: string;
  type: string;
  currency: string;
  amount: number;
  status: string;
  description: string | null;
  created_at: string;
};

export function StatementDialog({
  open,
  onOpenChange,
  transactions,
  accountId,
  fullName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  transactions: Tx[];
  accountId: string;
  fullName: string;
}) {
  const [range, setRange] = useState<"7" | "30" | "90">("30");

  const saveBlob = (blob: Blob, filename: string, mime: string) => {
    // Re-wrap to guarantee an explicit MIME type (iOS Safari otherwise treats octet-stream as "cannot download").
    const typedBlob = blob.type === mime ? blob : new Blob([blob], { type: mime });

    // Legacy IE / old Edge
    const navAny = navigator as any;
    if (navAny.msSaveOrOpenBlob) {
      navAny.msSaveOrOpenBlob(typedBlob, filename);
      return;
    }

    const url = URL.createObjectURL(typedBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.target = "_blank"; // iOS Safari respects target when download is honored, falls back to opening the file inline for save/share
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const filtered = () => {
    const days = Number(range);
    const cutoff = Date.now() - days * 864e5;
    return transactions.filter((t) => new Date(t.created_at).getTime() >= cutoff);
  };

  const downloadCsv = () => {
    const rows = [["Date", "Type", "Currency", "Amount", "Status", "Description"]];
    filtered().forEach((t) =>
      rows.push([
        format(new Date(t.created_at), "yyyy-MM-dd HH:mm"),
        t.type,
        t.currency,
        String(t.amount),
        t.status,
        (t.description ?? "").replace(/,/g, " "),
      ]),
    );
    const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    saveBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `sparkle-statement-${range}d.csv`, "text/csv;charset=utf-8");
  };

  const downloadPdf = () => {
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.setTextColor(30, 90, 110);
    doc.text("Sparkle Insure — Account Statement", 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(60);
    doc.text(`Account holder: ${fullName}`, 14, 30);
    doc.text(`Account ID: ${accountId}`, 14, 36);
    doc.text(`Period: last ${range} days`, 14, 42);
    doc.text(`Generated: ${format(new Date(), "d MMM yyyy HH:mm")}`, 14, 48);

    let y = 60;
    doc.setFontSize(9);
    doc.setFillColor(240, 240, 240);
    doc.rect(14, y - 5, 182, 7, "F");
    doc.text("Date", 16, y);
    doc.text("Type", 60, y);
    doc.text("Description", 90, y);
    doc.text("Amount", 172, y, { align: "right" });
    y += 6;

    filtered().forEach((t) => {
      if (y > 275) { doc.addPage(); y = 20; }
      doc.text(format(new Date(t.created_at), "yyyy-MM-dd"), 16, y);
      doc.text(t.type, 60, y);
      doc.text((t.description ?? "").slice(0, 40), 90, y);
      const sign = t.type === "withdrawal" ? "-" : "+";
      doc.text(`${sign}${formatMoney(Number(t.amount), t.currency as Currency)}`, 194, y, { align: "right" });
      y += 6;
    });

    const blob = doc.output("blob");
    saveBlob(blob, `sparkle-statement-${range}d.pdf`, "application/pdf");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Download statement</DialogTitle>
          <DialogDescription>Choose a date range and export your activity.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Date range</Label>
            <Select value={range} onValueChange={(v) => setRange(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
            {filtered().length} transaction{filtered().length === 1 ? "" : "s"} in this range.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={downloadCsv}>Download CSV</Button>
            <Button className="gradient-brand text-white" onClick={downloadPdf}>Download PDF</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
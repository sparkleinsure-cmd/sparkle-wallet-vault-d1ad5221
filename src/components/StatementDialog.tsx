import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { format } from "date-fns";
import jsPDF from "jspdf";
import { formatMoney, type Currency } from "@/lib/currency";
import { useServerFn } from "@tanstack/react-start";
import { getStatementTransactions } from "@/lib/wallet.functions";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

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
  accountId,
  fullName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  fullName: string;
}) {
  const [range, setRange] = useState<"7" | "30" | "90">("30");
  const [isGenerating, setIsGenerating] = useState(false);
  const getTransactions = useServerFn(getStatementTransactions);

  const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to prepare statement file."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(blob);
  });

  const saveBlob = async (blob: Blob, filename: string, mime: string) => {
    // Re-wrap to guarantee an explicit MIME type (iOS Safari otherwise treats octet-stream as "cannot download").
    const typedBlob = blob.type === mime ? blob : new Blob([blob], { type: mime });

    // Legacy IE / old Edge
    const navAny = navigator as any;
    if (navAny.msSaveOrOpenBlob) {
      navAny.msSaveOrOpenBlob(typedBlob, filename);
      return;
    }

    // Native Capacitor WebViews do not provide a reliable browser download
    // manager. Save the file natively, then open the device share/save sheet.
    if (Capacitor.isNativePlatform()) {
      const file = await Filesystem.writeFile({
        path: filename,
        data: await toBase64(typedBlob),
        directory: Directory.Documents,
      });
      const canShare = await Share.canShare();
      if (canShare.value) {
        await Share.share({
          title: "Sparkle Insure statement",
          files: [file.uri],
          dialogTitle: "Save or share statement",
        });
      } else {
        toast.success("Statement saved to your device.");
      }
      return;
    }

    // iOS does not consistently honour the download attribute for Blob URLs.
    // Its share sheet lets the customer save the statement to Files instead.
    const file = new File([typedBlob], filename, { type: mime });
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIOS && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Sparkle Insure statement" });
        return;
      } catch (error: any) {
        // A user cancelling the share sheet should not prevent the download fallback.
        if (error?.name !== "AbortError") console.warn("Statement share failed", error);
      }
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

  const fetchTransactions = async (): Promise<Tx[] | null> => {
    setIsGenerating(true);
    try {
      return await getTransactions({ data: { days: Number(range) as 7 | 30 | 90 } }) as Tx[];
    } catch (error: any) {
      toast.error(error?.message ?? "Unable to prepare your statement.");
      return null;
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadCsv = async () => {
    const transactions = await fetchTransactions();
    if (!transactions) return;
    const rows = [["Date", "Type", "Currency", "Amount", "Status", "Description"]];
    transactions.forEach((t) => {
      if (t.type === "bonus" && (t.description ?? "").startsWith("Account top up")) {
        t.status = "Topped up";
      }
      const statusLabel = t.type === "deposit" && t.status === "pending" ? "Topped up" : t.status;
      rows.push([
        format(new Date(t.created_at), "yyyy-MM-dd HH:mm"),
        t.type,
        t.currency,
        String(t.amount),
        statusLabel,
        t.description ?? "",
      ]);
    });
    const csv = rows
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    await saveBlob(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), `sparkle-statement-${range}d.csv`, "text/csv;charset=utf-8");
  };

  const downloadPdf = async () => {
    const transactions = await fetchTransactions();
    if (!transactions) return;
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

    const drawTableHeader = (y: number) => {
      doc.setFontSize(9);
      doc.setFillColor(240, 240, 240);
      doc.rect(14, y - 5, 182, 7, "F");
      doc.text("Date", 16, y);
      doc.text("Type", 48, y);
      doc.text("Description", 72, y);
      doc.text("Status", 142, y);
      doc.text("Amount", 194, y, { align: "right" });
      return y + 6;
    };

    let y = drawTableHeader(60);

    transactions.forEach((t) => {
      if (t.type === "bonus" && (t.description ?? "").startsWith("Account top up")) {
        t.status = "Topped up";
      }
      if (y > 275) {
        doc.addPage();
        y = drawTableHeader(20);
      }
      const statusLabel = t.type === "deposit" && t.status === "pending" ? "Topped up" : t.status;
      doc.text(format(new Date(t.created_at), "yyyy-MM-dd"), 16, y);
      doc.text(t.type, 48, y);
      doc.text((t.description ?? "").slice(0, 30), 72, y);
      doc.text(statusLabel, 140, y);
      doc.text(formatMoney(Number(t.amount), t.currency as Currency), 194, y, { align: "right" });
      y += 6;
    });

    const blob = doc.output("blob");
    await saveBlob(blob, `sparkle-statement-${range}d.pdf`, "application/pdf");
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
            Your statement will include all transactions from the last {range} days.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={downloadCsv} disabled={isGenerating}>Download CSV</Button>
            <Button className="gradient-brand text-white" onClick={downloadPdf} disabled={isGenerating}>
              {isGenerating ? "Preparing..." : "Download PDF"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

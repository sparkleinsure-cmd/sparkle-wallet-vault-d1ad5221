type TransactionDisplayInput = {
  type: string;
  amount: number;
  description?: string | null;
  reference?: string | null;
};

export function isPeerTransfer(transaction: TransactionDisplayInput) {
  return (
    transaction.type === "transfer" &&
    (/^PEER-(?:SENT|RECEIVED)-/.test(transaction.reference ?? "") ||
      /^(?:Sent to|Received from) /.test(transaction.description ?? ""))
  );
}

export function isTransactionDebit(transaction: TransactionDisplayInput) {
  const isSentTransfer =
    transaction.type === "transfer" &&
    (/^PEER-SENT-/.test(transaction.reference ?? "") ||
      (transaction.description ?? "").startsWith("Sent to "));

  return (
    isSentTransfer ||
    transaction.type === "withdrawal" ||
    transaction.type === "fee" ||
    Number(transaction.amount) < 0
  );
}

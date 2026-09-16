// Read complete result sets without depending on the PostgREST server row cap.
export async function readAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 500;
  for (;;) {
    const page = await fetchPage(rows.length, rows.length + pageSize - 1);
    if (page.error) throw new Error(page.error.message);
    if (!page.data?.length) return rows;
    rows.push(...page.data);
  }
}

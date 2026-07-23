import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const due = await admin
    .from("review_file_cleanup_queue")
    .select("id,bucket_id,object_path")
    .is("deleted_at", null)
    .not("delete_after", "is", null)
    .lte("delete_after", new Date().toISOString())
    .order("delete_after")
    .limit(100);

  if (due.error) return json({ error: due.error.message }, 500);

  let deleted = 0;
  const rows = due.data ?? [];
  for (const bucket of ["deposits", "kyc", "insurance"]) {
    const group = rows.filter((row) => row.bucket_id === bucket);
    if (!group.length) continue;

    const removal = await admin.storage.from(bucket).remove(group.map((row) => row.object_path));
    if (removal.error) {
      await admin
        .from("review_file_cleanup_queue")
        .update({ last_error: removal.error.message.slice(0, 500) })
        .in("id", group.map((row) => row.id));
      continue;
    }

    const completed = await admin
      .from("review_file_cleanup_queue")
      .update({ deleted_at: new Date().toISOString(), last_error: null })
      .in("id", group.map((row) => row.id));
    if (!completed.error) deleted += group.length;
  }

  return json({ ok: true, processed: rows.length, deleted });
});


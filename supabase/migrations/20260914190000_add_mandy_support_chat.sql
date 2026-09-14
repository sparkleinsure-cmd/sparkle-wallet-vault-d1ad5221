-- Private, one-to-one support conversations. All writes go through the
-- authenticated app-api Edge Function so members cannot impersonate Mandy or
-- an administrator. WhatsApp support remains an independent profile option.
CREATE TABLE IF NOT EXISTS public.support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ai'
    CHECK (status IN ('ai', 'waiting_for_admin', 'admin_active', 'closed')),
  assigned_admin_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  human_requested_at timestamptz,
  unread_by_admin integer NOT NULL DEFAULT 0 CHECK (unread_by_admin >= 0),
  unread_by_user integer NOT NULL DEFAULT 0 CHECK (unread_by_user >= 0),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'mandy', 'admin', 'system')),
  sender_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 2000),
  client_request_id uuid,
  reply_to_message_id uuid UNIQUE REFERENCES public.support_messages(id) ON DELETE SET NULL,
  ai_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS support_conversations_admin_inbox_idx
  ON public.support_conversations (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS support_messages_conversation_created_idx
  ON public.support_messages (conversation_id, created_at);

ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.support_conversations, public.support_messages
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.support_conversations, public.support_messages TO service_role;

COMMENT ON TABLE public.support_conversations IS
  'Private member support threads handled first by Mandy, then by an administrator on request.';

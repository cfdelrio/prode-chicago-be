-- Track pre-cutoff reminders already sent so we never spam a user twice
-- for the same (user, match, reminder_type).

CREATE TABLE IF NOT EXISTS reminder_sent (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    reminder_type VARCHAR(40) NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, match_id, reminder_type)
);

CREATE INDEX IF NOT EXISTS idx_reminder_sent_user_match
    ON reminder_sent(user_id, match_id);
CREATE INDEX IF NOT EXISTS idx_reminder_sent_type_sent
    ON reminder_sent(reminder_type, sent_at);

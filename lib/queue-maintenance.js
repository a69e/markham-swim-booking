export async function requeueExpiredCheckoutHolds(db) {
  const rows = await db`
    update queued_sessions
    set status = 'queued',
        checkout_token = null,
        checkout_token_expires_at = null,
        checkout_url_cipher = null,
        checkout_url_iv = null,
        checkout_url_tag = null,
        action_required_at = null,
        last_attempt_at = null,
        last_error = 'Checkout hold expired; queued again.',
        updated_at = now()
    where status = 'action_required'
      and checkout_token_expires_at is not null
      and checkout_token_expires_at <= now()
    returning id
  `;

  return rows.length;
}

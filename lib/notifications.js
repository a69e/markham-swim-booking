import webpush from "web-push";

function vapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject =
    process.env.VAPID_SUBJECT ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "mailto:markham-swim-booking@example.com";

  return { publicKey, privateKey, subject };
}

export function pushConfigured() {
  const { publicKey, privateKey } = vapidConfig();
  return Boolean(publicKey && privateKey);
}

export function publicVapidKey() {
  return vapidConfig().publicKey;
}

function configureWebPush() {
  const { publicKey, privateKey, subject } = vapidConfig();
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not configured.");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function notificationPayload({ queued, checkoutUrl }) {
  const session = queued.session || {};
  return JSON.stringify({
    title: "Swim spot held",
    body: `${session.service || "Swimming"} ${session.timeRange || ""}`.trim(),
    url: checkoutUrl,
    tag: `markham-swim-${queued.id}`,
  });
}

export async function sendCheckoutNotification(db, queued, checkoutUrl) {
  if (!pushConfigured()) {
    await db`
      update queued_sessions
      set notification_error = 'Web Push is not configured.',
          updated_at = now()
      where id = ${queued.id}
    `;
    return { sent: 0, error: "Web Push is not configured." };
  }

  configureWebPush();
  const accountRows = queued.account_id
    ? await db`
        select scoped.id
        from account_credentials current_account
        join account_credentials scoped
          on lower(scoped.email) = lower(current_account.email)
        where current_account.id = ${queued.account_id}
      `
    : [];
  const accountIds = accountRows.map((row) => row.id);
  const subscriptions = accountIds.length
    ? await db`
        select id, endpoint, subscription
        from push_subscriptions
        where account_id = any(${accountIds})
           or device_id = ${queued.device_id}
        order by updated_at desc
        limit 10
      `
    : await db`
        select id, endpoint, subscription
        from push_subscriptions
        where device_id = ${queued.device_id}
        order by updated_at desc
        limit 5
      `;

  if (!subscriptions.length) {
    await db`
      update queued_sessions
      set notification_error = 'No notification subscription saved for this device.',
          updated_at = now()
      where id = ${queued.id}
    `;
    return { sent: 0, error: "No notification subscription saved for this device." };
  }

  let sent = 0;
  const errors = [];
  const payload = notificationPayload({ queued, checkoutUrl });

  for (const item of subscriptions) {
    try {
      await webpush.sendNotification(item.subscription, payload);
      sent += 1;
      await db`
        update push_subscriptions
        set last_success_at = now(),
            last_error = null,
            updated_at = now()
        where id = ${item.id}
      `;
    } catch (error) {
      const message = error?.body || error?.message || "Push notification failed.";
      errors.push(message);
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await db`
          delete from push_subscriptions
          where id = ${item.id}
        `;
      } else {
        await db`
          update push_subscriptions
          set last_error = ${message},
              updated_at = now()
          where id = ${item.id}
        `;
      }
    }
  }

  await db`
    update queued_sessions
    set notified_at = case when ${sent} > 0 then now() else notified_at end,
        notification_error = ${errors[0] || ""},
        updated_at = now()
    where id = ${queued.id}
  `;

  return { sent, error: errors[0] || "" };
}

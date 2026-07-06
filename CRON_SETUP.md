# Queue Worker Cron

Vercel Hobby cannot run per-minute Cron Jobs, so use an external scheduler.

Recommended free setup:

- Service: `cron-job.org`
- URL: `https://markham-swim-booking.vercel.app/api/queue-worker?source=cron-job.org`
- Method: `GET`
- Schedule: every 1 minute
- Expected success code: `200`

Optional security:

1. Add a Vercel environment variable named `CRON_SECRET`.
2. Change the cron URL to:

```text
https://markham-swim-booking.vercel.app/api/queue-worker?source=cron-job.org&token=YOUR_CRON_SECRET
```

Check whether it is running:

```text
https://markham-swim-booking.vercel.app/api/status
```

Look at `lastQueueWorkerRun.createdAt`, `checkedCount`, `actionRequiredCount`, and `errorCount`.

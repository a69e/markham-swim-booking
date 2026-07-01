import { fetchLiveClassBatch } from "../lib/live-classes.js";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const after =
      typeof request.query.after === "string" ? request.query.after : "";
    const payload = await fetchLiveClassBatch(after);
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(payload);
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
}

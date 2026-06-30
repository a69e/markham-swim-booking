import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import handler from "../api/register.js";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function probeSummary(payload) {
  const firstLoggedInProbe = (payload.participantProbes || []).find(
    (probe) => probe.looksLoggedIn,
  );
  const forms = firstLoggedInProbe?.hints?.forms || [];
  const formDetails = firstLoggedInProbe?.hints?.formDetails || [];
  const participantForm = formDetails.find(
    (form) => form.id === "eventParticipantsSelection",
  );
  const selectionPreview = firstLoggedInProbe?.selectionPreview || null;

  return {
    ok: payload.ok,
    queued: payload.queued
      ? {
          service: payload.queued.service,
          date: payload.queued.date,
          timeRange: payload.queued.timeRange,
          location: payload.queued.location,
          action: payload.queued.action,
        }
      : null,
    registerUrlFound: Boolean(payload.registerUrl),
    participantLooksLoggedIn: Boolean(firstLoggedInProbe),
    participantTitle: firstLoggedInProbe?.hints?.title || "",
    forms: forms.map((form) => ({
      id: form.id,
      action: form.action,
      method: form.method,
    })),
    participantIndexes: participantForm?.participantIndexes || [],
    participants: participantForm?.participants || [],
    selectionPreview,
    participantControlCount: participantForm?.controls?.length || 0,
    buttons: firstLoggedInProbe?.hints?.buttons || [],
    outputFile: "",
  };
}

loadEnvFile(path.join(process.cwd(), ".env.local"));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env.local.");
}
if (!process.env.ENCRYPTION_KEY) {
  throw new Error("ENCRYPTION_KEY is missing from .env.local.");
}

const db = neon(process.env.DATABASE_URL);
const requestedDeviceId = process.argv[2] || "";
const participantIndex = process.argv[3] || "";
const accountRows = requestedDeviceId
  ? [{ device_id: requestedDeviceId }]
  : await db`
      select device_id
      from account_credentials
      order by updated_at desc
      limit 1
    `;

if (!accountRows.length) {
  throw new Error("No saved account found in account_credentials.");
}

const request = {
  method: "GET",
  query: {
    deviceId: accountRows[0].device_id,
    dryRun: "true",
    participantIndex,
  },
};
const response = createResponse();

await handler(request, response);

const outputFile = path.join(os.tmpdir(), "markham-register-probe.json");
fs.writeFileSync(outputFile, `${JSON.stringify(response.body, null, 2)}\n`);

const summary = probeSummary(response.body || {});
summary.outputFile = outputFile;
console.log(JSON.stringify({ statusCode: response.statusCode, ...summary }, null, 2));
process.exit(0);

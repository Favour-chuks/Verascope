import assert from "node:assert/strict";
import { POST, validateStartScanInput } from "@/app/api/scans/route";

const repoUrl = "https://github.com/vercel/next.js";

const invalidRuntime = validateStartScanInput({
  repoUrl,
  runtimeTarget: { mode: "repo_build", buildCommand: "npm run build" },
});
assert.equal(invalidRuntime.ok, false);
if (!invalidRuntime.ok) assert.equal(invalidRuntime.code, "invalid_runtime_target");

const missingConsent = validateStartScanInput({
  repoUrl,
  runtimeTarget: { mode: "user_url", targetUrl: "https://example.com", consentAttestation: false },
});
assert.equal(missingConsent.ok, false);
if (!missingConsent.ok) assert.equal(missingConsent.code, "consent_not_attested");

const invalidRepo = validateStartScanInput({
  repoUrl: "https://example.com/owner/repo",
  runtimeTarget: { mode: "demo_app" },
});
assert.equal(invalidRepo.ok, false);
if (!invalidRepo.ok) assert.equal(invalidRepo.code, "invalid_repo_url");

const previousUserUrlMode = process.env.ALLOW_USER_URL_MODE;
process.env.ALLOW_USER_URL_MODE = "false";
try {
  const disabled = await POST(new Request("http://localhost/api/scans", {
    method: "POST",
    body: JSON.stringify({
      repoUrl,
      runtimeTarget: { mode: "user_url", targetUrl: "https://example.com", consentAttestation: true },
    }),
  }));
  assert.equal(disabled.status, 400);
  assert.equal((await disabled.json()).error.code, "invalid_runtime_target");
} finally {
  if (previousUserUrlMode === undefined) delete process.env.ALLOW_USER_URL_MODE;
  else process.env.ALLOW_USER_URL_MODE = previousUserUrlMode;
}

const queued = await POST(new Request("http://localhost/api/scans", {
  method: "POST",
  body: JSON.stringify({ repoUrl, runtimeTarget: { mode: "demo_app" } }),
}));
assert.equal(queued.status, 201);
assert.equal((await queued.json()).status, "queued");

console.log("Scan route verification passed: typed runtime-target errors, consent gate, user_url kill switch, and queued acknowledgement.");

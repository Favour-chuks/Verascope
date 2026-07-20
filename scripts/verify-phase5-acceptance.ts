import assert from "node:assert/strict";
import { parsePhaseFiveTargets } from "./phase5-acceptance";

const targets = parsePhaseFiveTargets([
  "https://github.com/example/runnable",
  "https://github.com/example/not-runnable",
  "https://github.com/example/owned-live-app",
  "https://owned.example.test",
]);
assert.equal(targets.runnableRepo, "https://github.com/example/runnable");
assert.throws(() => parsePhaseFiveTargets([]), /Usage:/);
assert.throws(() => parsePhaseFiveTargets(["https://example.com/not-repo", "https://github.com/example/not-runnable", "https://github.com/example/owned-live-app", "https://owned.example.test"]), /phase5_repo_url_invalid/);
assert.throws(() => parsePhaseFiveTargets(["https://github.com/example/runnable", "https://github.com/example/not-runnable", "https://github.com/example/owned-live-app", "http://owned.example.test"]), /phase5_user_url_invalid/);
console.log("Phase 5 acceptance-runner contract passed: explicit runnable/non-runnable repositories, the owned live app repository, and an HTTPS user URL are required.");

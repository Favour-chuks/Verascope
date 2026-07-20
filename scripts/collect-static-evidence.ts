import { resolve } from "node:path";
import { collectStaticEvidence } from "@/lib/agents/static-evidence";

const repoIndex = process.argv.indexOf("--repo");
const repo = repoIndex >= 0 ? process.argv[repoIndex + 1] : undefined;
if (!repo) throw new Error("Usage: tsx scripts/collect-static-evidence.ts --repo <local-path>");

console.log(JSON.stringify(await collectStaticEvidence(resolve(repo)), null, 2));

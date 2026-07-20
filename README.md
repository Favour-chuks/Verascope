# Verascope

Verascope is an automated compliance and security auditor designed to analyze web applications for undisclosed data flows, dark patterns, security vulnerabilities, and licensing compliance. It goes beyond static code analysis by simulating real user flows in an isolated, privacy-preserving sandbox environment to observe actual runtime behavior.

## Core Features

- **Static Code Audits:** Analyzes repository source code, dependencies, and configuration files for security vulnerabilities, licensing issues, and potential AI vendor exposure.
- **Runtime Network Tracing:** Executes the application in an isolated sandbox, automatically navigates through critical user flows (like consent banners, authentication, and checkout), and intercepts network traffic to identify undisclosed data exfiltration.
- **Privacy-Preserving Architecture:** Network traces explicitly summarize payloads without capturing sensitive values (e.g., passwords, PII, internal tokens), preventing the audit tool itself from becoming a data liability.
- **Attribution Hijacking Detection:** Identifies deep-funnel dark patterns, such as malicious overriding of affiliate cookies during checkout flows.

### Components:
1. **Next.js Full-Stack Framework:** Handles the UI, scan initiation, and overarching orchestration.
2. **Supabase (PostgreSQL):** Persists scan status, event logs, and final audit reports.
3. **Vercel Sandboxes:** Provides the secure, isolated execution environment. 
   - *Static Phase:* Uses Vercel's `git_repo` manifest to stage the code without downloading it locally.
   - *Runtime Phase:* Boots an immutable, pre-provisioned snapshot containing Playwright and Chromium.
4. **Playwright:** Injected dynamically into the sandbox to drive headless browser sessions and intercept network requests.

## How We Built It: Collaborating with Codex & GPT-5.6

Building Verascope required complex orchestration between Next.js, Vercel Sandboxes, and headless Playwright instances. We relied heavily on OpenAI Codex and GPT-5.6 throughout the hackathon to accelerate our workflow and validate critical engineering decisions.

### Accelerating Our Workflow with Codex
Codex acted as our core engineering pair-programmer, accelerating development in several key areas:
- **Sandbox Orchestration:** We used Codex to rapidly prototype the `VercelRuntimeSandbox` integration, turning abstract ideas into working TypeScript code that manages the lifecycle of the sandbox, handles dynamic code injection (our `remoteRunner`), and safely tears down resources.
- **Complex Bash & Node.js Scripts:** The isolated Playwright script that drives the Chromium browser (`sandbox-executor.ts`) is highly complex and runs entirely within the sandbox. Codex helped write the tight, dependency-free Node.js logic that hooks into Playwright's `page.on("request")` to intercept and summarize network payloads on the fly.
- **Data Minimization Logic:** We collaborated with Codex to write the regex and JSON-parsing functions that count payload fields without retaining raw values.

### Key Engineering & Design Decisions using GPT-5.6
GPT-5.6 was our sounding board for system design and product strategy:
- **Privacy-Preserving Architecture:** Early in the hackathon, we debated how to store network traces. GPT-5.6 helped us realize that storing raw data payloads would turn our auditor into a massive security liability. We brainstormed the "Payload Summary" approach with the model, arriving at the current design where the sandbox only emits structural data (e.g., "JSON object with 2 fields").
- **Attribution Hijacking Tests:** We used GPT-5.6 to design the deep-funnel test suite. The model suggested the multi-pass approach: seeding an upstream affiliate cookie first, navigating to `/checkout`, and then asserting whether the app maliciously overwrites the credential.

### Contribution to the Final Result
Without Codex and GPT-5.6, wiring together an immutable Chromium snapshot inside a serverless sandbox and syncing those results with a Next.js orchestration layer would have taken weeks. 
- **Codex** provided the tactical, low-level execution that made the sandbox and static analysis engines a reality in hours. 
- **GPT-5.6** provided the high-level system architecture guidance, refined our UI/UX microcopy, and acts as the intelligence layer in the final product to synthesize raw evidence into actionable compliance reports.

## Getting Started

### Prerequisites
- Node.js 22.x
- A Supabase project
- Vercel Sandbox API access (for target repo staging)

### Installation
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Set up your `.env.local` file using the provided `.env.example`:
   ```bash
   cp .env.example .env.local
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```

### Provisioning the Runtime Browser (One-Time)
To ensure the runtime sandbox boots instantly, Verascope uses a pre-built image snapshot. If you are starting fresh, provision the Chromium snapshot:
```bash
npm run provision:runtime-browser-snapshot
```
Copy the resulting `snapshotId` into `src/lib/runtime/browser-snapshot.ts`.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

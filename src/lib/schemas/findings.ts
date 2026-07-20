import { z } from "zod";

export const CitationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), filePath: z.string().min(1), lineStart: z.number().int().positive().optional(), lineEnd: z.number().int().positive().optional() }),
  z.object({ type: z.literal("command"), command: z.string().min(1), output: z.string().min(1).max(4_000) }),
  z.object({
    type: z.literal("network_trace"),
    host: z.string().min(1),
    method: z.string().min(1),
    check: z.enum(["attribution_override", "unscripted", "pre_interaction", "consent_declined", "consent_accepted", "cname"]),
    flow: z.string().min(1),
    timingMs: z.number().int().nullable(),
    payloadSummary: z.string(),
  }),
]);

export const FindingSchema = z.object({
  category: z.enum(["code_quality", "security", "licensing", "ai_exposure", "runtime_disclosure", "team_risk"]),
  severity: z.enum(["critical", "notable", "minor"]),
  claim: z.string().min(1),
  whyItMatters: z.string().optional(),
  citation: CitationSchema,
  disclosedClaim: z.string().nullable().optional(),
  disclosedClaimLocation: z.string().nullable().optional(),
  outcome: z.enum(["conforms", "undisclosed", "contradicted"]).optional(),
  confidence: z.enum(["verified", "heuristic"]).default("verified"),
});

export const StaticAuditOutputSchema = z.object({
  findings: z.array(FindingSchema),
  notChecked: z.array(z.string()),
});

export type Finding = z.infer<typeof FindingSchema>;
export type StaticAuditOutput = z.infer<typeof StaticAuditOutputSchema>;

export function validateStaticFinding(raw: unknown): Finding | null {
  const parsed = FindingSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.citation.type === "command" && parsed.data.citation.output.length > 4_000) return null;
  return parsed.data;
}

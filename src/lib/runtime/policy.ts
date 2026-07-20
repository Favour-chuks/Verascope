import type { DisclosedClaim } from "@/lib/runtime/types";

function visibleText(document: string) {
  return document
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function kindFor(sentence: string): DisclosedClaim["kind"] {
  if (/(affiliate|referral|attribution)/i.test(sentence)) return "attribution";
  if (/(consent|cookie)/i.test(sentence)) return "consent";
  if (/analytics/i.test(sentence)) return "analytics";
  return "general";
}

/**
 * Deterministic, citation-preserving first pass. It records source text as it
 * appears rather than guessing at unnamed vendors or expanding vague policy
 * language into claims that are not actually present.
 */
export function extractDisclosureClaims(document: string, source: string): DisclosedClaim[] {
  const sentences = visibleText(document).match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => /(privacy|analytics|cookie|consent|affiliate|referral|attribution|third[- ]party|share)/i.test(sentence))
    .map((text, index) => ({ text, location: `${source} sentence ${index + 1}`, kind: kindFor(text) }));
}

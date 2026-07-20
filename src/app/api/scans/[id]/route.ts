import { NextResponse } from "next/server";
import { getApplicationScanStore } from "@/lib/scans/scan-store";
import { synthesizeReport } from "@/lib/reports/synthesis";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scan = await getApplicationScanStore().getScan(id);
  if (!scan) return NextResponse.json({ error: { code: "scan_not_found", message: "Scan not found." } }, { status: 404 });
  try {
    const report = scan.status === "complete"
      ? synthesizeReport({
        findings: scan.findings,
        notAssessed: scan.notAssessed,
        runtimeCoverage: scan.runtimeCoverage,
        generatedAt: scan.completedAt ?? scan.createdAt,
      })
      : null;
    return NextResponse.json({ scan, report });
  } catch {
    return NextResponse.json({ error: { code: "citation_validation_failed", message: "The report could not be assembled from cited evidence." } }, { status: 500 });
  }
}

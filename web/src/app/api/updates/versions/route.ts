/**
 * Update Versions API Route
 *
 * GET /api/updates/versions
 *
 * Returns list of available versions with their builds
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const versions = await prisma.agentVersion.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        releaseDate: 'desc',
      },
      include: {
        builds: {
          select: {
            platform: true,
            arch: true,
            filename: true,
            fileSize: true,
            sha256: true,
          },
        },
      },
      take: 10, // Limit to last 10 versions
    });

    return NextResponse.json({
      versions: versions.map((v) => ({
        version: v.version,
        channel: v.channel,
        releaseDate: v.releaseDate.toISOString(),
        releaseNotes: v.releaseNotes,
        builds: v.builds.map((b) => ({
          platform: b.platform,
          arch: b.arch,
          filename: b.filename,
          fileSize: b.fileSize,
          sha256: b.sha256,
        })),
      })),
    });
  } catch (error) {
    console.error('[Updates] Versions error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

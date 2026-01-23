/**
 * Update Download API Route
 *
 * GET /api/updates/download/:platform/:arch/:version
 *
 * Downloads the update package for the specified platform/arch/version
 * Requires machine authentication via headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

// Builds storage directory (configurable via env)
const BUILDS_DIR = process.env.BUILDS_DIR || '/var/www/html/screencontrol/builds';

// Map query param values to Prisma enum values
const platformMap: Record<string, 'WINDOWS' | 'MACOS' | 'LINUX'> = {
  windows: 'WINDOWS',
  macos: 'MACOS',
  linux: 'LINUX',
};

interface RouteParams {
  params: Promise<{
    platform: string;
    arch: string;
    version: string;
  }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const params = await context.params;
  const platform = params.platform?.toLowerCase();
  const arch = params.arch?.toLowerCase();
  const version = params.version;

  // Get machine authentication headers
  const machineId = request.headers.get('X-Machine-Id');
  const fingerprint = request.headers.get('X-Fingerprint');

  // Validate required params
  if (!platform || !arch || !version) {
    return NextResponse.json(
      { error: 'Missing required parameters' },
      { status: 400 }
    );
  }

  // Validate platform
  const prismaPlatform = platformMap[platform];
  if (!prismaPlatform) {
    return NextResponse.json(
      { error: `Invalid platform: ${platform}` },
      { status: 400 }
    );
  }

  // Validate arch
  if (!['x64', 'arm64'].includes(arch)) {
    return NextResponse.json(
      { error: `Invalid arch: ${arch}` },
      { status: 400 }
    );
  }

  // Validate machine authentication (optional but logged)
  if (machineId) {
    const agent = await prisma.agent.findFirst({
      where: { machineId },
      select: { id: true, machineFingerprint: true },
    });

    if (agent && fingerprint && agent.machineFingerprint !== fingerprint) {
      console.warn(
        `[Updates] Fingerprint mismatch for machine ${machineId}. ` +
          `Expected: ${agent.machineFingerprint}, Got: ${fingerprint}`
      );
      // Log but don't block - could be legitimate hardware change
    }
  }

  try {
    // Find the build
    const agentVersion = await prisma.agentVersion.findUnique({
      where: { version },
      include: {
        builds: {
          where: {
            platform: prismaPlatform,
            arch: arch,
          },
        },
      },
    });

    if (!agentVersion) {
      return NextResponse.json(
        { error: `Version ${version} not found` },
        { status: 404 }
      );
    }

    const build = agentVersion.builds[0];
    if (!build) {
      return NextResponse.json(
        { error: `No build available for ${platform}-${arch}` },
        { status: 404 }
      );
    }

    // Construct file path
    const filePath = path.join(BUILDS_DIR, build.storagePath);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`[Updates] Build file not found: ${filePath}`);
      return NextResponse.json(
        { error: 'Build file not found' },
        { status: 404 }
      );
    }

    // Get file stats
    const stats = fs.statSync(filePath);

    // Increment download count
    await prisma.agentBuild.update({
      where: { id: build.id },
      data: { downloadCount: { increment: 1 } },
    });

    // Log download
    console.log(
      `[Updates] Download: ${platform}-${arch} v${version} ` +
        `(machine: ${machineId || 'unknown'}, size: ${stats.size})`
    );

    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    const readableStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          controller.enqueue(new Uint8Array(buffer));
        });
        fileStream.on('end', () => {
          controller.close();
        });
        fileStream.on('error', (err) => {
          console.error('[Updates] Stream error:', err);
          controller.error(err);
        });
      },
    });

    // Determine content type based on extension
    const ext = path.extname(build.filename).toLowerCase();
    const contentType =
      ext === '.zip'
        ? 'application/zip'
        : ext === '.tar.gz' || ext === '.tgz'
          ? 'application/gzip'
          : 'application/octet-stream';

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': stats.size.toString(),
        'Content-Disposition': `attachment; filename="${build.filename}"`,
        'X-Content-SHA256': build.sha256,
      },
    });
  } catch (error) {
    console.error('[Updates] Download error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

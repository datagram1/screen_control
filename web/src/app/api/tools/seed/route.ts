/**
 * Tool Definitions Seed API Route
 *
 * POST /api/tools/seed - Import tool definitions from an active agent
 *
 * This endpoint queries an active agent's tools/list and populates
 * the tool definitions database with the schema and descriptions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { ToolCategory, OSType } from '@prisma/client';
import { agentRegistry } from '@/lib/control-server';

export const dynamic = 'force-dynamic';

// Map tool name prefixes/patterns to categories
function categorizeToolName(name: string): ToolCategory {
  const lowerName = name.toLowerCase();

  // Application management
  if (lowerName.includes('application') || lowerName.includes('app') ||
      lowerName.includes('launch') || lowerName.includes('focus') ||
      lowerName.includes('close')) {
    return 'APPLICATION';
  }

  // Screen/display
  if (lowerName.includes('screenshot') || lowerName.includes('screen') ||
      lowerName.includes('display') || lowerName.includes('capture')) {
    return 'SCREEN';
  }

  // Input/interaction
  if (lowerName.includes('click') || lowerName.includes('type') ||
      lowerName.includes('key') || lowerName.includes('mouse') ||
      lowerName.includes('drag') || lowerName.includes('scroll') ||
      lowerName.includes('tap') || lowerName.includes('swipe') ||
      lowerName.includes('gesture') || lowerName.includes('hover')) {
    return 'INPUT';
  }

  // Filesystem
  if (lowerName.includes('file') || lowerName.includes('fs_') ||
      lowerName.includes('read') || lowerName.includes('write') ||
      lowerName.includes('delete') || lowerName.includes('move') ||
      lowerName.includes('copy') || lowerName.includes('directory') ||
      lowerName.includes('folder') || lowerName.includes('path')) {
    return 'FILESYSTEM';
  }

  // System
  if (lowerName.includes('system') || lowerName.includes('info') ||
      lowerName.includes('process') || lowerName.includes('permission') ||
      lowerName.includes('window') || lowerName.includes('wait')) {
    return 'SYSTEM';
  }

  // Shell/command execution
  if (lowerName.includes('shell') || lowerName.includes('exec') ||
      lowerName.includes('command') || lowerName.includes('terminal') ||
      lowerName.includes('run')) {
    return 'SHELL';
  }

  // Clipboard
  if (lowerName.includes('clipboard') || lowerName.includes('copy') ||
      lowerName.includes('paste')) {
    return 'CLIPBOARD';
  }

  // Browser
  if (lowerName.includes('browser') || lowerName.includes('navigate') ||
      lowerName.includes('url') || lowerName.includes('tab') ||
      lowerName.includes('cookie') || lowerName.includes('web')) {
    return 'BROWSER';
  }

  // Network
  if (lowerName.includes('network') || lowerName.includes('http') ||
      lowerName.includes('request') || lowerName.includes('download') ||
      lowerName.includes('upload')) {
    return 'NETWORK';
  }

  // UI inspection
  if (lowerName.includes('ui') || lowerName.includes('element') ||
      lowerName.includes('ocr') || lowerName.includes('analyze') ||
      lowerName.includes('grid') || lowerName.includes('accessibility')) {
    return 'UI_INSPECTION';
  }

  // Default
  return 'SYSTEM';
}

// Check if a tool likely requires display
function requiresDisplay(name: string, description: string): boolean {
  const combined = `${name} ${description}`.toLowerCase();
  return combined.includes('screenshot') ||
         combined.includes('click') ||
         combined.includes('display') ||
         combined.includes('window') ||
         combined.includes('mouse') ||
         combined.includes('screen') ||
         combined.includes('ui') ||
         combined.includes('visual');
}

// Check if a tool is browser-related
function requiresBrowser(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName.includes('browser') ||
         lowerName.startsWith('browser_') ||
         lowerName.includes('tab') ||
         lowerName.includes('navigate') ||
         lowerName.includes('cookie');
}

export async function POST(request: NextRequest) {
  // Check authentication
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Check if user is admin
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, role: true },
  });

  if (user?.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { agentId, overwrite = false } = body;

    if (!agentId) {
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400 }
      );
    }

    // Get agent from database
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, hostname: true, osType: true, status: true, ownerUserId: true },
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    // Check agent ownership
    if (agent.ownerUserId !== user.id && user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Not authorized to access this agent' },
        { status: 403 }
      );
    }

    // Check if agent is connected
    const connectedAgent = agentRegistry.getAgent(agentId);
    if (!connectedAgent) {
      return NextResponse.json(
        { error: 'Agent is not connected' },
        { status: 400 }
      );
    }

    // Request tools/list from agent
    let toolsResult: unknown;
    try {
      toolsResult = await agentRegistry.sendCommand(agentId, 'tools/list', {});
    } catch (err) {
      return NextResponse.json(
        { error: `Agent error: ${(err as Error).message}` },
        { status: 500 }
      );
    }

    const tools = (toolsResult as { tools?: unknown[] })?.tools || [];
    if (!Array.isArray(tools) || tools.length === 0) {
      return NextResponse.json(
        { error: 'No tools returned from agent' },
        { status: 400 }
      );
    }

    // Import tools
    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const tool of tools) {
      try {
        const toolName = tool.name;
        const category = categorizeToolName(toolName);
        const needsDisplay = requiresDisplay(toolName, tool.description || '');
        const needsBrowser = requiresBrowser(toolName);

        // Check if tool exists
        const existing = await prisma.toolDefinition.findUnique({
          where: { name: toolName },
          include: { platformVariants: true },
        });

        if (existing) {
          if (!overwrite) {
            // Check if variant for this platform exists
            const existingVariant = existing.platformVariants.find(
              v => v.platform === agent.osType
            );

            if (existingVariant) {
              results.skipped++;
              continue;
            }
          }

          // Add/update platform variant
          await prisma.toolPlatformVariant.upsert({
            where: {
              toolId_platform: {
                toolId: existing.id,
                platform: agent.osType,
              },
            },
            update: {
              description: tool.description || '',
              inputSchema: tool.inputSchema || {},
              isAvailable: true,
              requiresDisplay: needsDisplay,
              requiresBrowser: needsBrowser,
            },
            create: {
              toolId: existing.id,
              platform: agent.osType,
              description: tool.description || '',
              inputSchema: tool.inputSchema || {},
              isAvailable: true,
              requiresDisplay: needsDisplay,
              requiresBrowser: needsBrowser,
            },
          });

          results.updated++;
        } else {
          // Create new tool definition
          await prisma.toolDefinition.create({
            data: {
              name: toolName,
              category,
              isEnabled: true,
              platformVariants: {
                create: {
                  platform: agent.osType,
                  description: tool.description || '',
                  inputSchema: tool.inputSchema || {},
                  isAvailable: true,
                  requiresDisplay: needsDisplay,
                  requiresBrowser: needsBrowser,
                },
              },
            },
          });

          results.created++;
        }
      } catch (error) {
        results.errors.push(`Failed to import ${tool.name}: ${(error as Error).message}`);
      }
    }

    // Record agent capabilities
    const allToolDefs = await prisma.toolDefinition.findMany({
      where: {
        name: { in: tools.map((t: { name: string }) => t.name) },
      },
    });

    // Upsert capabilities for this agent
    for (const toolDef of allToolDefs) {
      await prisma.agentToolCapability.upsert({
        where: {
          agentId_toolId: {
            agentId: agent.id,
            toolId: toolDef.id,
          },
        },
        update: {
          reportedAt: new Date(),
          isEnabled: true,
        },
        create: {
          agentId: agent.id,
          toolId: toolDef.id,
          isEnabled: true,
        },
      });
    }

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        hostname: agent.hostname,
        osType: agent.osType,
      },
      toolsReceived: tools.length,
      results,
    });
  } catch (error) {
    console.error('Error seeding tool definitions:', error);
    return NextResponse.json(
      { error: 'Failed to seed tool definitions' },
      { status: 500 }
    );
  }
}

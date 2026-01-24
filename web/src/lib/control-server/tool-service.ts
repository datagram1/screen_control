/**
 * Tool Service
 *
 * Provides server-side tool definitions from the database.
 * This replaces the need to query agents for tools/list.
 */

import { prisma } from '../prisma';
import { OSType, ToolCategory } from '@prisma/client';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface AggregatedTool extends MCPToolDefinition {
  agentId: string;
  agentName: string;
}

/**
 * Get tool definitions for a specific agent based on its platform and capabilities
 */
export async function getToolsForAgent(
  agentDbId: string
): Promise<MCPToolDefinition[]> {
  // Get agent with its platform
  const agent = await prisma.agent.findUnique({
    where: { id: agentDbId },
    select: {
      osType: true,
      hasDisplay: true,
      toolCapabilities: {
        where: { isEnabled: true },
        select: {
          tool: {
            select: {
              id: true,
              name: true,
              isEnabled: true,
              platformVariants: true,
            },
          },
        },
      },
    },
  });

  if (!agent) {
    return [];
  }

  const tools: MCPToolDefinition[] = [];

  // If agent has capabilities registered, use those
  if (agent.toolCapabilities.length > 0) {
    for (const capability of agent.toolCapabilities) {
      if (!capability.tool.isEnabled) continue;

      // Find platform-specific variant
      const variant = capability.tool.platformVariants.find(
        (v) => v.platform === agent.osType && v.isAvailable
      );

      if (!variant) continue;

      // Skip display-requiring tools for headless agents
      if (variant.requiresDisplay && !agent.hasDisplay) continue;

      tools.push({
        name: capability.tool.name,
        description: variant.description,
        inputSchema: variant.inputSchema as MCPToolDefinition['inputSchema'],
      });
    }
  } else {
    // Fallback: Return all available tools for this platform
    const allTools = await prisma.toolDefinition.findMany({
      where: {
        isEnabled: true,
        platformVariants: {
          some: {
            platform: agent.osType,
            isAvailable: true,
          },
        },
      },
      include: {
        platformVariants: {
          where: {
            platform: agent.osType,
            isAvailable: true,
          },
        },
      },
      orderBy: [
        { category: 'asc' },
        { sortOrder: 'asc' },
        { name: 'asc' },
      ],
    });

    for (const tool of allTools) {
      const variant = tool.platformVariants[0];
      if (!variant) continue;

      // Skip display-requiring tools for headless agents
      if (variant.requiresDisplay && !agent.hasDisplay) continue;

      tools.push({
        name: tool.name,
        description: variant.description,
        inputSchema: variant.inputSchema as MCPToolDefinition['inputSchema'],
      });
    }
  }

  return tools;
}

/**
 * Get aggregated tools from all active agents with database definitions
 */
export async function getAggregatedToolsFromDatabase(
  agentIds: string[],
  agentNameMap: Map<string, { name: string; osType: OSType; hasDisplay: boolean }>
): Promise<AggregatedTool[]> {
  const aggregatedTools: AggregatedTool[] = [];

  for (const agentId of agentIds) {
    const agentInfo = agentNameMap.get(agentId);
    if (!agentInfo) continue;

    const tools = await getToolsForAgent(agentId);

    for (const tool of tools) {
      aggregatedTools.push({
        ...tool,
        name: `${agentInfo.name}__${tool.name}`,
        description: `[${agentInfo.name}] ${tool.description}`,
        agentId,
        agentName: agentInfo.name,
      });
    }
  }

  return aggregatedTools;
}

/**
 * Update agent's tool capabilities based on reported tool names
 */
export async function updateAgentCapabilities(
  agentDbId: string,
  toolNames: string[]
): Promise<void> {
  // Get or create tool definitions for the reported names
  const existingTools = await prisma.toolDefinition.findMany({
    where: {
      name: { in: toolNames },
    },
  });

  const existingToolIds = new Set(existingTools.map((t) => t.id));
  const existingToolNames = new Set(existingTools.map((t) => t.name));

  // Delete old capabilities not in the new list
  await prisma.agentToolCapability.deleteMany({
    where: {
      agentId: agentDbId,
      toolId: { notIn: Array.from(existingToolIds) },
    },
  });

  // Upsert capabilities for existing tools
  for (const tool of existingTools) {
    await prisma.agentToolCapability.upsert({
      where: {
        agentId_toolId: {
          agentId: agentDbId,
          toolId: tool.id,
        },
      },
      update: {
        reportedAt: new Date(),
        isEnabled: true,
      },
      create: {
        agentId: agentDbId,
        toolId: tool.id,
        isEnabled: true,
      },
    });
  }

  // Log unknown tools for future reference
  const unknownTools = toolNames.filter((name) => !existingToolNames.has(name));
  if (unknownTools.length > 0) {
    console.log(
      `[ToolService] Agent ${agentDbId} reported ${unknownTools.length} unknown tools:`,
      unknownTools.slice(0, 10)
    );
  }
}

/**
 * Get all tool definitions grouped by category
 */
export async function getToolsByCategory(): Promise<
  Record<ToolCategory, MCPToolDefinition[]>
> {
  const tools = await prisma.toolDefinition.findMany({
    where: { isEnabled: true },
    include: {
      platformVariants: {
        where: { isAvailable: true },
      },
    },
    orderBy: [
      { category: 'asc' },
      { sortOrder: 'asc' },
      { name: 'asc' },
    ],
  });

  const result: Record<ToolCategory, MCPToolDefinition[]> = {} as Record<ToolCategory, MCPToolDefinition[]>;

  for (const category of Object.values(ToolCategory)) {
    result[category] = [];
  }

  for (const tool of tools) {
    // Use first available variant for description
    const variant = tool.platformVariants[0];
    if (!variant) continue;

    result[tool.category].push({
      name: tool.name,
      description: variant.description,
      inputSchema: variant.inputSchema as MCPToolDefinition['inputSchema'],
    });
  }

  return result;
}

/**
 * Check if a tool is available for an agent
 */
export async function isToolAvailableForAgent(
  agentDbId: string,
  toolName: string
): Promise<boolean> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentDbId },
    select: {
      osType: true,
      hasDisplay: true,
    },
  });

  if (!agent) return false;

  const tool = await prisma.toolDefinition.findUnique({
    where: { name: toolName },
    include: {
      platformVariants: {
        where: {
          platform: agent.osType,
          isAvailable: true,
        },
      },
    },
  });

  if (!tool || !tool.isEnabled) return false;
  if (tool.platformVariants.length === 0) return false;

  const variant = tool.platformVariants[0];
  if (variant.requiresDisplay && !agent.hasDisplay) return false;

  return true;
}

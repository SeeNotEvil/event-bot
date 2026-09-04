import type { FunctionTool } from 'openai/resources/responses/responses';
import { toOpenAITool, type AnyTool, type ToolDefinition } from './Tool.js';

export class UnknownToolError extends Error {
  public constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  public register<Input, Output>(tool: ToolDefinition<Input, Output>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as AnyTool);
    return this;
  }

  public get(name: string): AnyTool {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new UnknownToolError(name);
    }

    return tool;
  }

  public specs(): FunctionTool[] {
    return [...this.tools.values()].map(toOpenAITool);
  }
}

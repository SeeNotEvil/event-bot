import type { FunctionTool } from 'openai/resources/responses/responses';
import { zodResponsesFunction } from 'openai/helpers/zod';
import { z, type ZodType } from 'zod';
import type { AgentContext } from '../../types/domain.js';

export type ToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: ZodType<Input>;
  output: ZodType<Output>;
  terminal?: boolean;
  requiresUser?: boolean;
  availableWhen?: (context: AgentContext) => boolean;
  execute: (context: AgentContext, input: Input) => Promise<Output>;
  transcript?: (input: Input, output: Output) => string | null;
};

export type AnyTool = ToolDefinition<unknown, unknown>;

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

function toStrictParameters(schema: ZodType): Record<string, unknown> {
  const parameters = zodResponsesFunction({
    name: '_schema',
    parameters: schema,
  }).parameters;

  if (parameters === null) {
    throw new Error('A tool schema must produce a JSON object schema');
  }

  return parameters;
}

function toStrictOutputSchema(schema: ZodType): Record<string, unknown> {
  const envelope = toStrictParameters(z.object({ value: schema }));
  const properties = envelope.properties;

  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('Strict schema conversion did not produce object properties');
  }

  const outputSchema = (properties as Record<string, unknown>).value;
  if (outputSchema === null || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) {
    throw new Error('Strict schema conversion did not produce an output schema');
  }

  return outputSchema as Record<string, unknown>;
}

export function toOpenAITool(tool: AnyTool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: toStrictParameters(tool.input),
    output_schema: toStrictOutputSchema(tool.output),
    strict: true,
  };
}

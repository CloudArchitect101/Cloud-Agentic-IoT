/**
 * Model Context Protocol (MCP) server exposing patient-device capabilities as
 * tools that any MCP-speaking agent can discover and call.
 *
 * Why MCP rather than a bespoke REST API: the agent discovers the tools at
 * runtime from tools/list, so adding a capability does not require redeploying
 * or re-prompting the agent. The contract is the schema, not the prompt.
 */

const TOOLS = [
  {
    name: 'get_device_telemetry',
    description:
      'Returns the most recent temperature and humidity reading for one patient device. ' +
      'Use when asked about current conditions for a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'AWS IoT Thing name, e.g. ESP32-Patient-Monitor-01' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'get_queue_depth',
    description:
      'Returns the number of open Cases in a named Salesforce care team queue. ' +
      'Use when asked how much work is outstanding.',
    inputSchema: {
      type: 'object',
      properties: {
        queueDeveloperName: { type: 'string' },
      },
      required: ['queueDeveloperName'],
    },
  },
];

/**
 * A tool description is read by the model to decide when to call it, so it is
 * prompt engineering with a schema attached. Vague descriptions produce agents
 * that call the wrong tool confidently.
 */
exports.handler = async (event) => {
  let request;
  try {
    request = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  const { id = null, method, params = {} } = request || {};

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cloud-agentic-iot', version: '1.0.0' },
      });

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call':
      return handleToolCall(id, params);

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
};

async function handleToolCall(id, params) {
  const { name, arguments: args = {} } = params;
  const tool = TOOLS.find((t) => t.name === name);

  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  }

  // Validate against the declared schema rather than trusting the caller.
  // The caller is a language model; required fields go missing.
  const missing = (tool.inputSchema.required || []).filter((k) => args[k] === undefined);
  if (missing.length) {
    return rpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
    });
  }

  try {
    const text = await dispatch(name, args);
    return rpcResult(id, { content: [{ type: 'text', text }] });
  } catch (err) {
    // Surface the failure as tool output, not as a transport error: the agent
    // can reason about "the device is offline" but not about an HTTP 500.
    return rpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: `Tool ${name} failed: ${err.message}` }],
    });
  }
}

async function dispatch(name, args) {
  switch (name) {
    case 'get_device_telemetry':
      return `Device ${args.deviceId}: 21.4 C, 47% humidity (placeholder — wire to the DynamoDB table from branch 01).`;
    case 'get_queue_depth':
      return `Queue ${args.queueDeveloperName}: 3 open cases (placeholder — wire to the Salesforce query from branch 03).`;
    default:
      throw new Error(`No dispatcher for ${name}`);
  }
}

const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });

function json(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

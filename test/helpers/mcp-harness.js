import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../../src/server.js';

/**
 * Connects a real MCP Client to the production server through a linked pair of in-memory
 * transports. Returns the client and a close function.
 */
export async function connectMcpClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = createServer();
  const client = new Client({name: 'substack-mcp-test-client', version: '1.0.0'}, {capabilities: {}});

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    async close() {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

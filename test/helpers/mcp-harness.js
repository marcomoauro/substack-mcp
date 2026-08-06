import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../../src/server.js';

/**
 * Collega un Client MCP reale al server di produzione tramite una coppia di transport
 * in memoria. Restituisce il client e una funzione di chiusura.
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

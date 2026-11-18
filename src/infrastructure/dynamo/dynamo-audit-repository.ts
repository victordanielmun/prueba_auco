import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { RepositoryError } from '../../domain/errors';
import type { ValidationAuditEvent } from '../../domain/models';
import type { AuditRepository, HealthProbe } from '../../domain/ports';

export interface DynamoConfig {
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createDynamoClient(config: DynamoConfig): DynamoDBClient {
  return new DynamoDBClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 3,
  });
}

/**
 * Crea la tabla de auditoría si no existe. Idempotente:
 *  - si ya existe no hace nada,
 *  - si dos instancias la crean a la vez, ResourceInUseException se ignora.
 *
 * Esquema: PK `documentNumber` (HASH) + SK `eventTimestamp` (RANGE).
 */
export async function ensureAuditTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'documentNumber', AttributeType: 'S' },
          { AttributeName: 'eventTimestamp', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'documentNumber', KeyType: 'HASH' },
          { AttributeName: 'eventTimestamp', KeyType: 'RANGE' },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }

  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
}

export class DynamoAuditRepository implements AuditRepository, HealthProbe {
  readonly name = 'dynamodb';
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async record(event: ValidationAuditEvent): Promise<void> {
    try {
      await this.doc.send(new PutCommand({ TableName: this.tableName, Item: event }));
    } catch (err) {
      throw new RepositoryError('DynamoAuditRepository.record', err);
    }
  }

  async check(): Promise<void> {
    await this.client.send(new DescribeTableCommand({ TableName: this.tableName }));
  }
}

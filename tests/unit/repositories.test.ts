import {
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { MongoClient } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryError } from '../../src/domain/errors';
import type { ValidationRecord } from '../../src/domain/models';
import {
  createDynamoClient,
  DynamoAuditRepository,
  ensureAuditTable,
} from '../../src/infrastructure/dynamo/dynamo-audit-repository';
import { MongoValidationRepository } from '../../src/infrastructure/mongo/mongo-validation-repository';

const dynamo = () =>
  createDynamoClient({ region: 'us-east-1', endpoint: 'http://localhost:1', accessKeyId: 'x', secretAccessKey: 'x' });

const notFound = () => new ResourceNotFoundException({ message: 'nf', $metadata: {} });
const inUse = () => new ResourceInUseException({ message: 'in use', $metadata: {} });
const commandName = (cmd: unknown) => (cmd as { constructor: { name: string } }).constructor.name;

describe('ensureAuditTable (creación idempotente)', () => {
  it('no crea la tabla si ya existe', async () => {
    const client = dynamo();
    const send = vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation(async () => ({ Table: { TableStatus: 'ACTIVE' } }) as never);

    await ensureAuditTable(client, 'audit');

    expect(send.mock.calls.map(([c]) => commandName(c))).toEqual(['DescribeTableCommand']);
  });

  it('crea la tabla con PK documentNumber y SK eventTimestamp si no existe', async () => {
    const client = dynamo();
    let created = false;
    const send = vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation((async (cmd: unknown) => {
      const name = commandName(cmd);
      if (name === 'DescribeTableCommand' && !created) throw notFound();
      if (name === 'CreateTableCommand') created = true;
      return { Table: { TableStatus: 'ACTIVE' } };
    }) as never);

    await ensureAuditTable(client, 'audit');

    const create = send.mock.calls.map(([c]) => c).find((c) => commandName(c) === 'CreateTableCommand') as {
      input: { TableName: string; KeySchema: unknown };
    };
    expect(create.input.TableName).toBe('audit');
    expect(create.input.KeySchema).toEqual([
      { AttributeName: 'documentNumber', KeyType: 'HASH' },
      { AttributeName: 'eventTimestamp', KeyType: 'RANGE' },
    ]);
  });

  it('ignora ResourceInUseException (carrera entre instancias)', async () => {
    const client = dynamo();
    let describeCalls = 0;
    vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation((async (cmd: unknown) => {
      const name = commandName(cmd);
      if (name === 'DescribeTableCommand') {
        describeCalls++;
        if (describeCalls === 1) throw notFound();
        return { Table: { TableStatus: 'ACTIVE' } };
      }
      throw inUse(); // CreateTable: otra instancia ganó
    }) as never);

    await expect(ensureAuditTable(client, 'audit')).resolves.toBeUndefined();
  });

  it('propaga errores inesperados', async () => {
    vi.spyOn(DynamoDBClient.prototype, 'send').mockRejectedValue(new Error('access denied'));
    await expect(ensureAuditTable(dynamo(), 'audit')).rejects.toThrow('access denied');
  });
});

describe('DynamoAuditRepository', () => {
  const event = {
    documentNumber: 'AB123456',
    eventTimestamp: '2026-01-01T00:00:00.000Z#e1',
    eventId: 'e1',
    eventType: 'VALIDATION_CREATED' as const,
    validationId: 'v1',
    status: 'APPROVED' as const,
  };

  it('escribe el evento con PutCommand en la tabla configurada', async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({} as never);

    await new DynamoAuditRepository(dynamo(), 'audit').record(event);

    const cmd = send.mock.calls[0]![0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input).toEqual({ TableName: 'audit', Item: event });
  });

  it('envuelve los fallos en RepositoryError', async () => {
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(new Error('throttled'));
    await expect(new DynamoAuditRepository(dynamo(), 'audit').record(event)).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('MongoValidationRepository', () => {
  const record: ValidationRecord = {
    id: 'v1',
    name: 'Ada',
    documentNumber: 'AB123456',
    countryCode: null,
    status: 'APPROVED',
    reasons: [],
    enrichment: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  function build() {
    const collection = {
      dbName: 'db',
      insertOne: vi.fn(),
      findOne: vi.fn(),
      createIndex: vi.fn(),
    };
    const command = vi.fn();
    const client = { db: () => ({ collection: () => collection, command }) } as unknown as MongoClient;
    return { repo: new MongoValidationRepository(client, 'db', 'validations'), collection, command };
  }

  it('guarda el id de dominio como _id', async () => {
    const { repo, collection } = build();
    await repo.insert(record);
    const { id, ...rest } = record;
    expect(collection.insertOne).toHaveBeenCalledWith({ _id: id, ...rest });
  });

  it('findById reconstruye el registro de dominio', async () => {
    const { repo, collection } = build();
    const { id, ...rest } = record;
    collection.findOne.mockResolvedValue({ _id: id, ...rest });
    expect(await repo.findById('v1')).toEqual(record);
    expect(collection.findOne).toHaveBeenCalledWith({ _id: 'v1' });
  });

  it('findById devuelve null si no existe', async () => {
    const { repo, collection } = build();
    collection.findOne.mockResolvedValue(null);
    expect(await repo.findById('nope')).toBeNull();
  });

  it('envuelve los fallos en RepositoryError', async () => {
    const { repo, collection } = build();
    collection.insertOne.mockRejectedValue(new Error('duplicate key'));
    collection.findOne.mockRejectedValue(new Error('timeout'));
    await expect(repo.insert(record)).rejects.toBeInstanceOf(RepositoryError);
    await expect(repo.findById('v1')).rejects.toBeInstanceOf(RepositoryError);
  });

  it('check hace ping y ensureIndexes es repetible', async () => {
    const { repo, collection, command } = build();
    await repo.check();
    await repo.ensureIndexes();
    await repo.ensureIndexes();
    expect(command).toHaveBeenCalledWith({ ping: 1 });
    expect(collection.createIndex).toHaveBeenCalledTimes(2);
  });
});

import { MongoClient, type Collection } from 'mongodb';
import { RepositoryError } from '../../domain/errors';
import type { ValidationRecord } from '../../domain/models';
import type { HealthProbe, ValidationRepository } from '../../domain/ports';

/** Forma del documento en Mongo: el `id` de dominio se guarda como `_id`. */
type ValidationDoc = Omit<ValidationRecord, 'id'> & { _id: string };

export function createMongoClient(uri: string): MongoClient {
  return new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'validation-service' });
}

export class MongoValidationRepository implements ValidationRepository, HealthProbe {
  readonly name = 'mongodb';

  constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<ValidationDoc>,
  ) {}

  /** Crea índices de forma idempotente (createIndex no falla si ya existen). */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ documentNumber: 1, createdAt: -1 });
  }

  async insert(record: ValidationRecord): Promise<void> {
    const { id, ...rest } = record;
    try {
      await this.collection.insertOne({ _id: id, ...rest });
    } catch (err) {
      throw new RepositoryError('MongoValidationRepository.insert', err);
    }
  }

  async findById(id: string): Promise<ValidationRecord | null> {
    try {
      const doc = await this.collection.findOne({ _id: id });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return { id: _id, ...rest };
    } catch (err) {
      throw new RepositoryError('MongoValidationRepository.findById', err);
    }
  }

  async check(): Promise<void> {
    await this.client.db().command({ ping: 1 });
  }
}

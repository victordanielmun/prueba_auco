const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/** Especificación OpenAPI 3 servida en `/docs` (UI) y `/docs.json`. */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Validation Service',
    version: '1.0.0',
    description:
      'Valida documentos, los enriquece con APICountries, los guarda en MongoDB y audita cada evento en DynamoDB Local.',
  },
  servers: [{ url: '/' }],
  tags: [{ name: 'Validations' }, { name: 'Health' }],
  paths: {
    '/validations': {
      post: {
        tags: ['Validations'],
        summary: 'Crea una validación',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateValidationInput' },
              example: { name: 'Ada Lovelace', documentNumber: 'AB-123456', countryCode: 'CO' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Validación creada',
            headers: { Location: { schema: { type: 'string' }, description: 'URL del recurso' } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Validation' } } },
          },
          '400': errorResponse('Body inválido'),
          '401': errorResponse('Token ausente o inválido'),
          '413': errorResponse('Body demasiado grande'),
          '429': errorResponse('Demasiadas peticiones'),
        },
      },
    },
    '/validations/{id}': {
      get: {
        tags: ['Validations'],
        summary: 'Obtiene una validación por id',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Validación encontrada',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Validation' } } },
          },
          '400': errorResponse('id inválido (no es UUID)'),
          '401': errorResponse('Token ausente o inválido'),
          '404': errorResponse('No existe'),
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Estado del servicio y de sus dependencias',
        responses: {
          '200': { description: 'Todo operativo' },
          '503': { description: 'Alguna dependencia caída' },
        },
      },
    },
    '/health/live': {
      get: { tags: ['Health'], summary: 'Liveness', responses: { '200': { description: 'Proceso vivo' } } },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      CreateValidationInput: {
        type: 'object',
        required: ['name', 'documentNumber'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120 },
          documentNumber: { type: 'string', minLength: 1, maxLength: 32, description: 'Se normaliza a mayúsculas sin espacios' },
          countryCode: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'ISO 3166-1 alpha-2 (opcional)' },
        },
      },
      CountryEnrichment: {
        type: 'object',
        nullable: true,
        properties: {
          provider: { type: 'string', enum: ['apicountries'] },
          code: { type: 'string' },
          name: { type: 'string' },
          region: { type: 'string', nullable: true },
          subregion: { type: 'string', nullable: true },
          capital: { type: 'string', nullable: true },
          currencies: { type: 'array', items: { type: 'string' } },
          callingCode: { type: 'string', nullable: true },
          origin: { type: 'string', enum: ['api', 'cache', 'stale-cache', 'fallback'] },
          enrichedAt: { type: 'string', format: 'date-time' },
        },
      },
      Validation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          documentNumber: { type: 'string' },
          countryCode: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['APPROVED', 'REJECTED', 'REVIEW'] },
          reasons: { type: 'array', items: { type: 'string' } },
          enrichment: { $ref: '#/components/schemas/CountryEnrichment' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

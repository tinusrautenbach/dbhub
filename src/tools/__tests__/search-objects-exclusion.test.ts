import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSearchDatabaseObjectsToolHandler } from '../search-objects.js';
import { ConnectorManager } from '../../connectors/manager.js';
import type { Connector, ConnectorType } from '../../connectors/interface.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');

// Mock connector
const createMockConnector = (id: ConnectorType = 'sqlite'): Connector => ({
    id,
    name: 'Mock Connector',
    getId: () => 'default',
    dsnParser: {} as any,
    connect: vi.fn(),
    disconnect: vi.fn(),
    clone: vi.fn(),
    getSchemas: vi.fn(),
    getTables: vi.fn(),
    tableExists: vi.fn(),
    getTableSchema: vi.fn(),
    getTableIndexes: vi.fn(),
    getStoredProcedures: vi.fn(),
    getStoredProcedureDetail: vi.fn(),
    executeSQL: vi.fn(),
});

// Helper to parse tool response
const parseToolResponse = (response: any) => {
    return JSON.parse(response.content[0].text);
};

describe('search_database_objects tool exclusion logic', () => {
    let mockConnector: Connector;
    const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

    beforeEach(() => {
        mockConnector = createMockConnector('sqlite');
        mockGetCurrentConnector.mockReturnValue(mockConnector);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('schema exclusion', () => {
        beforeEach(() => {
            vi.mocked(mockConnector.getSchemas).mockResolvedValue([
                'public',
                '_timescaledb_internal',
                '_timescaledb_config',
                'my_schema',
            ]);
        });

        it('should exclude schemas matching pattern', async () => {
            const config = {
                exclude_schemas: ['_timescaledb_%'],
            };
            const handler = createSearchDatabaseObjectsToolHandler('default', config);
            const result = await handler(
                {
                    object_type: 'schema',
                    pattern: '%',
                    detail_level: 'names',
                },
                null
            );

            const parsed = parseToolResponse(result);
            expect(parsed.data.results.map((r: any) => r.name)).toEqual(['public', 'my_schema']);
        });

        it('should not exclude anything if no pattern matches', async () => {
            const config = {
                exclude_schemas: ['nonexistent_%'],
            };
            const handler = createSearchDatabaseObjectsToolHandler('default', config);
            const result = await handler(
                {
                    object_type: 'schema',
                    pattern: '%',
                    detail_level: 'names',
                },
                null
            );

            const parsed = parseToolResponse(result);
            expect(parsed.data.count).toBe(4);
        });

        it('should handle multiple exclusion patterns', async () => {
            const config = {
                exclude_schemas: ['_timescaledb_%', 'my_%'],
            };
            const handler = createSearchDatabaseObjectsToolHandler('default', config);
            const result = await handler(
                {
                    object_type: 'schema',
                    pattern: '%',
                    detail_level: 'names',
                },
                null
            );

            const parsed = parseToolResponse(result);
            expect(parsed.data.results.map((r: any) => r.name)).toEqual(['public']);
        });
    });

    describe('table exclusion', () => {
        beforeEach(() => {
            vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
            vi.mocked(mockConnector.getTables).mockResolvedValue([
                'users',
                'orders',
                'flyway_schema_history',
                'pg_stat_statements',
            ]);
        });

        it('should exclude tables matching pattern', async () => {
            const config = {
                exclude_tables: ['flyway_%', 'pg_%'],
            };
            const handler = createSearchDatabaseObjectsToolHandler('default', config);
            const result = await handler(
                {
                    object_type: 'table',
                    pattern: '%',
                    schema: 'public',
                    detail_level: 'names',
                },
                null
            );

            const parsed = parseToolResponse(result);
            expect(parsed.data.results.map((r: any) => r.name)).toEqual(['users', 'orders']);
        });
    });
});

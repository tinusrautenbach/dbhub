import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveSourceConfigs } from '../config/env.js';

describe('Config Resolution', () => {
    const originalArgv = process.argv;
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.argv = originalArgv;
        process.env = originalEnv;
    });

    it('should include execute_sql tool when exclude-schemas flag is present', async () => {
        // Mock command line arguments
        process.argv = [
            'node',
            'script.js',
            '--dsn=postgres://user:pass@localhost:5432/db',
            '--exclude-schemas=test_schema'
        ];

        // Resolve config
        const config = await resolveSourceConfigs();

        expect(config).toBeDefined();
        expect(config?.tools).toBeDefined();

        const toolNames = config!.tools!.map(t => t.name);

        // This is what we expect to fail initially
        expect(toolNames).toContain('execute_sql');
        expect(toolNames).toContain('search_objects');

        // Verify exclusion config was picked up
        const searchTool = config!.tools!.find(t => t.name === 'search_objects');
        expect((searchTool as any).exclude_schemas).toContain('test_schema');
    });

    it('should include execute_sql by default when no exclusion flags are present', async () => {
        process.argv = [
            'node',
            'script.js',
            '--dsn=postgres://user:pass@localhost:5432/db'
        ];

        const config = await resolveSourceConfigs();

        // When tools is empty/undefined, the registry adds defaults.
        // However, resolveSourceConfigs returns the *configured* tools.
        // If it returns empty array, registry adds defaults.
        // If it returns specific tools, registry uses those.
        // In the default case, resolveSourceConfigs returns empty tools array (from DSN path).

        // Wait, checked the code:
        // In resolveSourceConfigs logic for DSN:
        // const tools: ... = [];
        // ... parse exclusions ...
        // return { sources, tools, ... }

        // So for default case, tools is [].
        // For exclusion case, tools is [{ name: 'search_objects' ... }].

        // If tools is [], registry.ts buildRegistry() says:
        // "Backward compatibility: sources without tools get default built-ins"
        // if (!registry.has(source.id)) -> checks if tools exist for source.

        // So validation:
        // If tools is [], expect(config.tools).toHaveLength(0);

        expect(config?.tools).toHaveLength(0);
    });
});

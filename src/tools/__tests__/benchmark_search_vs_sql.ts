
import "../../connectors/postgres/index.js";
import "../../connectors/sqlserver/index.js";
import "../../connectors/sqlite/index.js";
import "../../connectors/mysql/index.js";
import "../../connectors/mariadb/index.js";
import { createSearchDatabaseObjectsToolHandler } from "../search-objects.js";
import { createExecuteSqlToolHandler } from "../execute-sql.js";
import { resolveSourceConfigs } from "../../config/env.js";
import { ConnectorManager } from "../../connectors/manager.js";

async function runBenchmark() {
    console.log("Starting benchmark...");

    // Initialize connection
    const config = await resolveSourceConfigs();
    if (!config || config.sources.length === 0) {
        console.error("No valid database configuration found.");
        process.exit(1);
    }

    const sourceConfig = config.sources[0];
    console.log(`Connecting to ${sourceConfig.type} database at ${sourceConfig.host}...`);

    // Initialize ConnectorManager
    const manager = new ConnectorManager();
    await manager.connectWithSources([sourceConfig]);

    const searchHandler = createSearchDatabaseObjectsToolHandler(sourceConfig.id);
    const sqlHandler = createExecuteSqlToolHandler(sourceConfig.id);

    const iterations = 5;

    async function measure(name: string, fn: () => Promise<any>) {
        const times: number[] = [];
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            await fn();
            const end = performance.now();
            times.push(end - start);
        }
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        console.log(`${name}: Average ${avg.toFixed(2)}ms over ${iterations} iterations`);
        return avg;
    }

    console.log("\n--- Benchmarking Table Count ---");
    await measure("search_objects (schema)", async () => {
        // search_objects for schema with summary details gives a table count per schema
        await searchHandler({ object_type: "schema", detail_level: "summary" }, null as any);
    });

    await measure("execute_sql (count)", async () => {
        // Simple count of all tables
        await sqlHandler({ sql: "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog')" }, null as any);
    });


    console.log("\n--- Benchmarking List Tables (Names) ---");
    await measure("search_objects (table names)", async () => {
        await searchHandler({ object_type: "table", detail_level: "names" }, null as any);
    });

    await measure("execute_sql (table names)", async () => {
        await sqlHandler({ sql: "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog')" }, null as any);
    });


    console.log("\n--- Benchmarking Table Metadata (Full) ---");
    // Limit to 10 tables to avoid overwhelming if DB is huge, but enough to see N+1 impact
    const LIMIT = 10;

    await measure(`search_objects (full details, limit ${LIMIT})`, async () => {
        await searchHandler({ object_type: "table", detail_level: "full", limit: LIMIT }, null as any);
    });

    // Note: execute_sql equivalent is complex to match exactly what search_objects does (columns, indexes, row counts),
    // but we can approximate the "bulk fetch" efficiency.
    await measure(`execute_sql (bulk columns fetch apprx, limit ${LIMIT})`, async () => {
        await sqlHandler({
            sql: `
        SELECT c.table_schema, c.table_name, c.column_name, c.data_type 
        FROM information_schema.columns c
        JOIN information_schema.tables t ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        WHERE t.table_schema NOT IN ('information_schema', 'pg_catalog')
        ORDER BY c.table_schema, c.table_name
        LIMIT ${LIMIT * 10} -- assuming avg 10 cols per table
     `}, null as any);
    });

    console.log("\nBenchmark complete.");
    process.exit(0);
}

runBenchmark().catch(console.error);

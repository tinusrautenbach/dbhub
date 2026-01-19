import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import type { Connector } from "../connectors/interface.js";
import { quoteQualifiedIdentifier } from "../utils/identifier-quoter.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";

/**
 * Object types that can be searched
 */
export type DatabaseObjectType = "schema" | "table" | "column" | "procedure" | "index";

/**
 * Detail level for search results
 * - names: Just object names (minimal tokens)
 * - summary: Names + brief metadata (row count, column count, etc.)
 * - full: Complete structure details
 */
export type DetailLevel = "names" | "summary" | "full";

// Schema for search_objects tool (unified search and list)
export const searchDatabaseObjectsSchema = {
  object_type: z
    .enum(["schema", "table", "column", "procedure", "index"])
    .describe("Object type to search"),
  pattern: z
    .string()
    .optional()
    .default("%")
    .describe("LIKE pattern (% = any chars, _ = one char). Default: %"),
  schema: z
    .string()
    .optional()
    .describe("Filter to schema"),
  table: z
    .string()
    .optional()
    .describe("Filter to table (requires schema; column/index only)"),
  detail_level: z
    .enum(["names", "summary", "full"])
    .default("names")
    .describe("Detail: names (minimal), summary (metadata), full (all)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe("Max results (default: 100, max: 1000)"),
};

/**
 * Convert SQL LIKE pattern to JavaScript regex
 * Supports % (any chars) and _ (single char)
 */
function likePatternToRegex(pattern: string): RegExp {
  // Escape special regex characters except % and _
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Get row count estimate for a table
 */
async function getTableRowCount(
  connector: Connector,
  tableName: string,
  schemaName?: string
): Promise<number | null> {
  try {
    // Use proper identifier quoting to handle special characters and reserved keywords
    const qualifiedTable = quoteQualifiedIdentifier(tableName, schemaName, connector.id);
    const countQuery = `SELECT COUNT(*) as count FROM ${qualifiedTable}`;
    const result = await connector.executeSQL(countQuery, { maxRows: 1 });

    if (result.rows && result.rows.length > 0) {
      return Number(result.rows[0].count || result.rows[0].COUNT || 0);
    }
  } catch (error) {
    // If we can't get row count, return null (not critical)
    return null;
  }
  return null;
}

/**
 * Search for schemas
 */
async function searchSchemas(
  connector: Connector,
  pattern: string,
  detailLevel: DetailLevel,
  limit: number,
  filterSchemas: (schemas: string[]) => string[]
): Promise<any[]> {
  // Optimized query for Postgres
  if (connector.id === "postgres" && detailLevel !== "names") {
    try {
      const sql = `
        SELECT 
          n.nspname as name, 
          COUNT(c.relname)::int as table_count
        FROM pg_catalog.pg_namespace n
        LEFT JOIN pg_catalog.pg_class c ON n.oid = c.relnamespace AND c.relkind = 'r'
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND n.nspname LIKE $1
        GROUP BY n.nspname
        ORDER BY n.nspname
        LIMIT $2
      `;
      // We pass the LIKE pattern as a parameter
      // Note: filterSchemas logic must be applied via SQL or post-filtering
      // Since filterSchemas is JS logic based on exclusion config, we can't easily push it to SQL 
      // unless we parse the config again here. 
      // However, we can fetch slightly more and filter in JS, or if allow list is huge, this optimization is tricky.
      // But search_objects exclusion is usually a few patterns. 
      // Let's implement basic optimization first.

      const result = await connector.executeSQL(sql, {}, [pattern, limit * 2]); // Fetch more to allow for post-filtering

      let rows: any[] = result.rows;

      // Apply filterSchemas
      const schemaNames = rows.map(r => r.name);
      const allowedSchemaNames = new Set(filterSchemas(schemaNames));
      rows = rows.filter(r => allowedSchemaNames.has(r.name));

      // Apply limit after filtering
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
      }

      return rows.map(r => ({
        name: r.name,
        table_count: r.table_count
      }));

    } catch (e) {
      console.warn("Optimized searchSchemas failed, falling back to default:", e);
      // Fallback to default implementation
    }
  }

  const allSchemas = await connector.getSchemas();
  const schemas = filterSchemas(allSchemas);
  const regex = likePatternToRegex(pattern);
  const matched = schemas.filter((schema: string) => regex.test(schema)).slice(0, limit);

  if (detailLevel === "names") {
    return matched.map((name: string) => ({ name }));
  }

  // For summary and full, add table count
  const results = await Promise.all(
    matched.map(async (schemaName: string) => {
      try {
        const tables = await connector.getTables(schemaName);
        return {
          name: schemaName,
          table_count: tables.length,
        };
      } catch (error) {
        return {
          name: schemaName,
          table_count: 0,
        };
      }
    })
  );

  return results;
}

/**
 * Search for tables
 */
async function searchTables(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number,
  filterSchemas: (schemas: string[]) => string[],
  filterTables: (tables: string[]) => string[]
): Promise<any[]> {
  // Optimized query for Postgres
  if (connector.id === "postgres") {
    try {
      // Get schemas to search
      let schemasToSearch: string[];
      if (schemaFilter) {
        schemasToSearch = [schemaFilter];
      } else {
        const allSchemas = await connector.getSchemas();
        schemasToSearch = filterSchemas(allSchemas);
      }

      if (schemasToSearch.length === 0) return [];

      const regex = likePatternToRegex(pattern);

      // 1. Fetch tables with row count estimates
      // We fetch slightly more to allow for filtering
      const fetchLimit = limit * 2;

      const tablesSql = `
        SELECT 
          t.table_schema, 
          t.table_name,
          COALESCE(pc.reltuples, 0)::bigint as row_count
        FROM information_schema.tables t
        LEFT JOIN pg_class pc ON pc.relname = t.table_name AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
        WHERE t.table_schema = ANY($1)
          AND t.table_name LIKE $2
          AND t.table_type = 'BASE TABLE'
        LIMIT $3
      `;

      const tablesResult = await connector.executeSQL(tablesSql, {}, [schemasToSearch, pattern, fetchLimit]);

      let tables = tablesResult.rows.map(r => ({
        name: r.table_name,
        schema: r.table_schema,
        row_count: Number(r.row_count) // Convert bigint to number
      }));

      // Apply table exclusions using the provided filterTables function
      const tableNames = tables.map(t => t.name);
      // This simple filter might be incorrect if multiple schemas have same table name but different exclusion rules? 
      // The current filterTables checks strictly table name so it's consistent.
      const allowedTableNames = new Set(filterTables(tableNames));

      tables = tables.filter(t => allowedTableNames.has(t.name));

      // Limit results
      if (tables.length > limit) {
        tables = tables.slice(0, limit);
      }

      if (detailLevel === "names") {
        return tables.map(t => ({
          name: t.name,
          schema: t.schema
        }));
      }

      // For summary/full, we need column counts/info
      // Batch fetch columns for these tables
      if (tables.length > 0) {
        const targetSchemas = [...new Set(tables.map(t => t.schema))];
        const targetTableNames = [...new Set(tables.map(t => t.name))];

        const columnsSql = `
          SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, ordinal_position
          FROM information_schema.columns
          WHERE table_schema = ANY($1)
          AND table_name = ANY($2)
          ORDER BY table_schema, table_name, ordinal_position
        `;

        const columnsResult = await connector.executeSQL(columnsSql, {}, [targetSchemas, targetTableNames]);

        // Group columns by schema.table
        const columnsMap = new Map<string, any[]>();
        for (const col of columnsResult.rows) {
          const key = `${col.table_schema}.${col.table_name}`;
          if (!columnsMap.has(key)) columnsMap.set(key, []);
          columnsMap.get(key)?.push(col);
        }

        // For full detail, also fetch indexes
        let indexesMap = new Map<string, any[]>();
        if (detailLevel === 'full') {
          const indexesSql = `
            SELECT 
              ns.nspname as schema_name,
              t.relname as table_name,
              i.relname as index_name,
              array_agg(a.attname)::text[] as column_names,
              ix.indisunique as is_unique,
              ix.indisprimary as is_primary
            FROM pg_index ix
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
            JOIN pg_namespace ns ON ns.oid = t.relnamespace
            WHERE ns.nspname = ANY($1)
            AND t.relname = ANY($2)
            AND t.relkind = 'r'
            GROUP BY ns.nspname, t.relname, i.relname, ix.indisunique, ix.indisprimary, ix.indkey
           `;

          try {
            // Note: array_agg might return different format depending on driver, 
            // but usually string[] or string representation. PG driver usually handles array types.
            const indexesResult = await connector.executeSQL(indexesSql, {}, [targetSchemas, targetTableNames]);

            for (const idx of indexesResult.rows) {
              const key = `${idx.schema_name}.${idx.table_name}`;
              if (!indexesMap.has(key)) indexesMap.set(key, []);
              indexesMap.get(key)?.push({
                name: idx.index_name,
                columns: idx.column_names,
                unique: idx.is_unique,
                primary: idx.is_primary
              });
            }
          } catch (e) {
            console.warn("Failed to batch fetch indexes:", e);
          }
        }

        // Assemble results
        return tables.map(t => {
          const key = `${t.schema}.${t.name}`;
          const cols = columnsMap.get(key) || [];

          if (detailLevel === 'summary') {
            return {
              name: t.name,
              schema: t.schema,
              column_count: cols.length,
              row_count: t.row_count
            };
          } else {
            const idxs = indexesMap.get(key) || [];
            return {
              name: t.name,
              schema: t.schema,
              column_count: cols.length,
              row_count: t.row_count,
              columns: cols.map(c => ({
                name: c.column_name,
                type: c.data_type,
                nullable: c.is_nullable === 'YES',
                default: c.column_default
              })),
              indexes: idxs
            };
          }
        });
      }
      return [];

    } catch (e) {
      console.warn("Optimized searchTables failed, falling back to default:", e);
      // Fallback
    }
  }

  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    const allSchemas = await connector.getSchemas();
    schemasToSearch = filterSchemas(allSchemas);
  }

  // Search tables in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const allTables = await connector.getTables(schemaName);
      const tables = filterTables(allTables);
      const matched = tables.filter((table: string) => regex.test(table));

      for (const tableName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: tableName,
            schema: schemaName,
          });
        } else if (detailLevel === "summary") {
          // Get column count for summary
          try {
            const columns = await connector.getTableSchema(tableName, schemaName);
            const rowCount = await getTableRowCount(connector, tableName, schemaName);

            results.push({
              name: tableName,
              schema: schemaName,
              column_count: columns.length,
              row_count: rowCount,
            });
          } catch (error) {
            results.push({
              name: tableName,
              schema: schemaName,
              column_count: null,
              row_count: null,
            });
          }
        } else {
          // full detail
          try {
            const columns = await connector.getTableSchema(tableName, schemaName);
            const indexes = await connector.getTableIndexes(tableName, schemaName);
            const rowCount = await getTableRowCount(connector, tableName, schemaName);

            results.push({
              name: tableName,
              schema: schemaName,
              column_count: columns.length,
              row_count: rowCount,
              columns: columns.map((col: any) => ({
                name: col.column_name,
                type: col.data_type,
                nullable: col.is_nullable === "YES",
                default: col.column_default,
              })),
              indexes: indexes.map((idx: any) => ({
                name: idx.index_name,
                columns: idx.column_names,
                unique: idx.is_unique,
                primary: idx.is_primary,
              })),
            });
          } catch (error) {
            results.push({
              name: tableName,
              schema: schemaName,
              error: `Unable to fetch full details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Search for columns
 */
async function searchColumns(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  tableFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number,
  filterSchemas: (schemas: string[]) => string[],
  filterTables: (tables: string[]) => string[]
): Promise<any[]> {
  // Optimized query for Postgres
  if (connector.id === "postgres") {
    try {
      // If schema is provided, use it. If not, use all schemas (filtered)
      let schemasToSearch: string[];
      if (schemaFilter) {
        schemasToSearch = [schemaFilter];
      } else {
        const allSchemas = await connector.getSchemas();
        schemasToSearch = filterSchemas(allSchemas);
      }

      if (schemasToSearch.length > 0) {
        // Construct query
        let sql = `
          SELECT 
            table_schema, 
            table_name, 
            column_name, 
            data_type, 
            is_nullable, 
            column_default
          FROM information_schema.columns
          WHERE table_schema = ANY($1)
         `;

        const queryParams: any[] = [schemasToSearch];

        if (tableFilter) {
          sql += ` AND table_name = $2`;
          queryParams.push(tableFilter);
        } else {
          // If we are filtering tables using the exclusion list, we can't easily do it in SQL unless we query all and filter in JS.
          // But we can apply the pattern for column name
        }

        // Add column name pattern
        const paramOffset = queryParams.length;
        sql += ` AND column_name LIKE $${paramOffset + 1}`;
        queryParams.push(pattern);

        // Order and Limit
        sql += ` ORDER BY table_schema, table_name, ordinal_position LIMIT $${queryParams.length + 1}`;
        queryParams.push(limit * 2);

        const result = await connector.executeSQL(sql, {}, queryParams);

        let rows = result.rows;

        // Apply table filtering if needed
        if (!tableFilter) {
          const distinctTables = [...new Set(rows.map(r => r.table_name))];
          const allowedTables = new Set(filterTables(distinctTables));
          rows = rows.filter(r => allowedTables.has(r.table_name));
        }

        if (rows.length > limit) {
          rows = rows.slice(0, limit);
        }

        if (detailLevel === "names") {
          return rows.map(r => ({
            name: r.column_name,
            table: r.table_name,
            schema: r.table_schema
          }));
        } else {
          return rows.map(r => ({
            name: r.column_name,
            table: r.table_name,
            schema: r.table_schema,
            type: r.data_type,
            nullable: r.is_nullable === "YES",
            default: r.column_default
          }));
        }
      }

    } catch (e) {
      console.warn("Optimized searchColumns failed, falling back:", e);
    }
  }

  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    const allSchemas = await connector.getSchemas();
    schemasToSearch = filterSchemas(allSchemas);
  }

  // Search columns in tables across schemas
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      // Get tables to search
      let tablesToSearch: string[];
      if (tableFilter) {
        // If table filter is specified, only search that table
        tablesToSearch = [tableFilter];
      } else {
        // Otherwise search all tables in the schema
        const allTables = await connector.getTables(schemaName);
        tablesToSearch = filterTables(allTables);
      }

      for (const tableName of tablesToSearch) {
        if (results.length >= limit) break;

        try {
          const columns = await connector.getTableSchema(tableName, schemaName);
          const matchedColumns = columns.filter((col: any) => regex.test(col.column_name));

          for (const column of matchedColumns) {
            if (results.length >= limit) break;

            if (detailLevel === "names") {
              results.push({
                name: column.column_name,
                table: tableName,
                schema: schemaName,
              });
            } else {
              // summary and full are the same for columns
              results.push({
                name: column.column_name,
                table: tableName,
                schema: schemaName,
                type: column.data_type,
                nullable: column.is_nullable === "YES",
                default: column.column_default,
              });
            }
          }
        } catch (error) {
          // Skip tables we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Search for stored procedures
 */
async function searchProcedures(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number,
  filterSchemas: (schemas: string[]) => string[]
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    const allSchemas = await connector.getSchemas();
    schemasToSearch = filterSchemas(allSchemas);
  }

  // Search procedures in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const procedures = await connector.getStoredProcedures(schemaName);
      const matched = procedures.filter((proc: string) => regex.test(proc));

      for (const procName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: procName,
            schema: schemaName,
          });
        } else {
          // summary and full - get procedure details
          try {
            const details = await connector.getStoredProcedureDetail(procName, schemaName);
            results.push({
              name: procName,
              schema: schemaName,
              type: details.procedure_type,
              language: details.language,
              parameters: detailLevel === "full" ? details.parameter_list : undefined,
              return_type: details.return_type,
              definition: detailLevel === "full" ? details.definition : undefined,
            });
          } catch (error) {
            results.push({
              name: procName,
              schema: schemaName,
              error: `Unable to fetch details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access or databases that don't support procedures
      continue;
    }
  }

  return results;
}

/**
 * Search for indexes
 */
async function searchIndexes(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  tableFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number,
  filterSchemas: (schemas: string[]) => string[],
  filterTables: (tables: string[]) => string[]
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    const allSchemas = await connector.getSchemas();
    schemasToSearch = filterSchemas(allSchemas);
  }

  // Search indexes in tables across schemas
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      // Get tables to search
      let tablesToSearch: string[];
      if (tableFilter) {
        // If table filter is specified, only search that table
        tablesToSearch = [tableFilter];
      } else {
        // Otherwise search all tables in the schema
        const allTables = await connector.getTables(schemaName);
        tablesToSearch = filterTables(allTables);
      }

      for (const tableName of tablesToSearch) {
        if (results.length >= limit) break;

        try {
          const indexes = await connector.getTableIndexes(tableName, schemaName);
          const matchedIndexes = indexes.filter((idx: any) => regex.test(idx.index_name));

          for (const index of matchedIndexes) {
            if (results.length >= limit) break;

            if (detailLevel === "names") {
              results.push({
                name: index.index_name,
                table: tableName,
                schema: schemaName,
              });
            } else {
              // summary and full are the same for indexes
              results.push({
                name: index.index_name,
                table: tableName,
                schema: schemaName,
                columns: index.column_names,
                unique: index.is_unique,
                primary: index.is_primary,
              });
            }
          }
        } catch (error) {
          // Skip tables we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Create a search_database_objects tool handler
 */
export function createSearchDatabaseObjectsToolHandler(sourceId?: string, config?: { exclude_schemas?: string[], exclude_tables?: string[] }) {
  return async (args: any, extra: any) => {
    const {
      object_type,
      pattern = "%",
      schema,
      table,
      detail_level = "names",
      limit = 100,
    } = args as {
      object_type: DatabaseObjectType;
      pattern?: string;
      schema?: string;
      table?: string;
      detail_level: DetailLevel;
      limit: number;
    };

    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      const connector = ConnectorManager.getCurrentConnector(sourceId);

      // Tool is already registered, so it's enabled (no need to check)

      // Validate table parameter
      if (table) {
        // Schema is no longer strictly required for table parameter
        // But if schema is not provided, we will search across all schemas (which might receive multiple same-named tables)
        if (!["column", "index"].includes(object_type)) {
          success = false;
          errorMessage = `The 'table' parameter only applies to object_type 'column' or 'index', not '${object_type}'`;
          return createToolErrorResponse(errorMessage, "INVALID_TABLE_FILTER");
        }
      }

      // Validate schema if provided
      if (schema) {
        const schemas = await connector.getSchemas();
        if (!schemas.includes(schema)) {
          success = false;
          errorMessage = `Schema '${schema}' does not exist. Available schemas: ${schemas.join(", ")}`;
          return createToolErrorResponse(errorMessage, "SCHEMA_NOT_FOUND");
        }
      }

      let results: any[] = [];

      // Compile exclusion regexes
      const schemaExclusions = config?.exclude_schemas?.map(likePatternToRegex) || [];
      const tableExclusions = config?.exclude_tables?.map(likePatternToRegex) || [];

      const isSchemaExcluded = (schemaName: string) => {
        return schemaExclusions.some(regex => regex.test(schemaName));
      };

      const isTableExcluded = (tableName: string) => {
        return tableExclusions.some(regex => regex.test(tableName));
      };

      // Helper to filter schemas
      const filterSchemas = (schemas: string[]) => {
        if (schemaExclusions.length === 0) return schemas;
        return schemas.filter(s => !isSchemaExcluded(s));
      };

      // Helper to filter tables
      const filterTables = (tables: string[]) => {
        if (tableExclusions.length === 0) return tables;
        return tables.filter(t => !isTableExcluded(t));
      };


      // Route to appropriate search function
      switch (object_type) {
        case "schema":
          results = await searchSchemas(connector, pattern, detail_level, limit, filterSchemas);
          break;
        case "table":
          results = await searchTables(connector, pattern, schema, detail_level, limit, filterSchemas, filterTables);
          break;
        case "column":
          results = await searchColumns(connector, pattern, schema, table, detail_level, limit, filterSchemas, filterTables);
          break;
        case "procedure":
          results = await searchProcedures(connector, pattern, schema, detail_level, limit, filterSchemas);
          break;
        case "index":
          results = await searchIndexes(connector, pattern, schema, table, detail_level, limit, filterSchemas, filterTables);
          break;
        default:
          success = false;
          errorMessage = `Unsupported object_type: ${object_type}`;
          return createToolErrorResponse(errorMessage, "INVALID_OBJECT_TYPE");
      }

      return createToolSuccessResponse({
        object_type,
        pattern,
        schema,
        table,
        detail_level,
        count: results.length,
        results,
        truncated: results.length === limit,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(
        `Error searching database objects: ${errorMessage}`,
        "SEARCH_ERROR"
      );
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "search_objects" : `search_objects_${effectiveSourceId}`,
          sql: `search_objects(object_type=${object_type}, pattern=${pattern}, schema=${schema || "all"}, table=${table || "all"}, detail_level=${detail_level})`,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
